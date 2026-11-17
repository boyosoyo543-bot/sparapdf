import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'

const AUTH_DIR = process.env.AUTH_DIR || './auth'
const PHONE = (process.env.PHONE || '').replace(/[^0-9]/g, '')

const PDF_PAGE_SIZE = (
  process.env.PDF_PAGE_SIZE || 'A4'
).toUpperCase()

const UPSCALE_FACTOR = Math.min(
  2,
  Math.max(
    1,
    Number.parseFloat(
      process.env.UPSCALE_FACTOR || '2'
    ) || 2
  )
)

const logger = pino({ level: 'silent' })

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms))

function ensureDirectories() {
  fs.mkdirSync(AUTH_DIR, {
    recursive: true
  })
}

function getMessageContent(message) {
  return (
    normalizeMessageContent(message.message) ||
    message.message
  )
}

function getMedia(content) {
  // صورة عادية من WhatsApp
  if (content?.imageMessage) {
    return {
      kind: 'image',
      media: content.imageMessage
    }
  }

  // ملفات Documents المرسلة من CamScanner
  const document =
    content?.documentMessage

  if (!document) {
    return null
  }

  const mime = (
    document.mimetype || ''
  )
    .split(';')[0]
    .toLowerCase()

  const name = (
    document.fileName || ''
  ).toLowerCase()

  // PDF جاهز من CamScanner
  if (
    mime === 'application/pdf' ||
    name.endsWith('.pdf')
  ) {
    return {
      kind: 'pdf',
      media: document
    }
  }

  // صور مرسلة كـDocument
  const isImage =
    mime.startsWith('image/') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.webp')

  return isImage
    ? {
        kind: 'image',
        media: document
      }
    : null
}

function getPageSize() {
  if (PDF_PAGE_SIZE === 'LETTER') {
    return [612, 792]
  }

  if (PDF_PAGE_SIZE === 'ORIGINAL') {
    return null
  }

  return [595.28, 841.89]
}

function fitInside(
  width,
  height,
  maxWidth,
  maxHeight
) {
  const scale = Math.min(
    maxWidth / width,
    maxHeight / height
  )

  return {
    width: width * scale,
    height: height * scale
  }
}

async function downloadMedia(
  message,
  sock
) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          'تحميل الملف خذا وقت طويل بزاف، عاود صيفطو من فضلك.'
        )
      )
    }, 30000)
  })

  const download =
    downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger,

        // إعادة طلب الرابط إذا كان منتهي
        reuploadRequest: oldMessage =>
          sock.updateMediaMessage(oldMessage)
      }
    )

  return Promise.race([
    download,
    timeout
  ])
}

function rowProjectionScore(
  data,
  width,
  height
) {
  const rows =
    new Array(height).fill(0)

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    let sum = 0

    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      const value =
        data[y * width + x]

      // البكسلات الغامقة غالباً هي الكتابة
      sum += Math.max(
        0,
        235 - value
      )
    }

    rows[y] = sum
  }

  const mean =
    rows.reduce(
      (a, b) => a + b,
      0
    ) / rows.length

  return rows.reduce(
    (total, value) =>
      total + ((value - mean) ** 2),
    0
  ) / rows.length
}

async function estimateDeskewAngle(
  inputBuffer
) {
  const angles = []

  for (
    let angle = -5;
    angle <= 5;
    angle += 1
  ) {
    angles.push(angle)
  }

  let bestAngle = 0
  let bestScore = -Infinity

  for (const angle of angles) {
    const {
      data,
      info
    } = await sharp(
      inputBuffer,
      {
        failOn: 'none'
      }
    )
      .rotate()
      .rotate(angle, {
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        }
      })
      .resize({
        width: 900,
        withoutEnlargement: true
      })
      .greyscale()
      .raw()
      .toBuffer({
        resolveWithObject: true
      })

    const score =
      rowProjectionScore(
        data,
        info.width,
        info.height
      )

    if (score > bestScore) {
      bestScore = score
      bestAngle = angle
    }
  }

  return bestAngle
}

async function enhanceAndDeskewImage(
  inputBuffer
) {
  const angle =
    await estimateDeskewAngle(
      inputBuffer
    )

  // تصحيح اتجاه الصورة والميلان
  const rotated =
    await sharp(
      inputBuffer,
      {
        failOn: 'none'
      }
    )
      .rotate()
      .rotate(angle, {
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        }
      })
      // قص الحواف البيضاء والفارغة
      .trim({
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        },
        threshold: 22
      })
      // تحسين الإضاءة والتباين
      .normalize()
      // تقوية وضوح الكتابة
      .sharpen({
        sigma: 1.1,
        m1: 0.7,
        m2: 2.0
      })
      // PNG بدون ضغط ضياعي
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true
      })
      .toBuffer()

  const metadata =
    await sharp(rotated).metadata()

  const width =
    metadata.width || 1600

  const height =
    metadata.height || 1200

  // تكبير حتى 2x
  return sharp(rotated)
    .resize({
      width: Math.round(
        width * UPSCALE_FACTOR
      ),
      height: Math.round(
        height * UPSCALE_FACTOR
      ),
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false
    })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true
    })
    .toBuffer()
}

async function createPdfFromImage(
  imageBuffer
) {
  const pdfDoc =
    await PDFDocument.create()

  pdfDoc.setTitle(
    'Enhanced CamScanner Image'
  )

  pdfDoc.setProducer(
    'WhatsApp CamScanner Bot'
  )

  const image =
    await pdfDoc.embedPng(
      imageBuffer
    )

  const dimensions =
    image.scale(1)

  const pageSize =
    getPageSize()

  if (!pageSize) {
    const page = pdfDoc.addPage([
      dimensions.width,
      dimensions.height
    ])

    page.drawImage(image, {
      x: 0,
      y: 0,
      width: dimensions.width,
      height: dimensions.height
    })
  } else {
    const [
      pageWidth,
      pageHeight
    ] = pageSize

    const fitted =
      fitInside(
        dimensions.width,
        dimensions.height,
        pageWidth,
        pageHeight
      )

    const page = pdfDoc.addPage([
      pageWidth,
      pageHeight
    ])

    page.drawImage(image, {
      x:
        (pageWidth - fitted.width) / 2,
      y:
        (pageHeight - fitted.height) / 2,
      width: fitted.width,
      height: fitted.height
    })
  }

  const bytes =
    await pdfDoc.save({
      useObjectStreams: true
    })

  return Buffer.from(bytes)
}

async function start() {
  ensureDirectories()

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    AUTH_DIR
  )

  const {
    version
  } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger
  })

  let pairingRequested = false

  sock.ev.on(
    'creds.update',
    saveCreds
  )

  sock.ev.on(
    'connection.update',
    async ({
      connection,
      lastDisconnect,
      qr
    }) => {
      if (
        qr &&
        !pairingRequested &&
        !sock.authState.creds.registered &&
        PHONE
      ) {
        pairingRequested = true

        try {
          const code =
            await sock.requestPairingCode(
              PHONE
            )

          console.log(
            'PAIRING CODE:',
            code
          )
        } catch (error) {
          console.log(
            'PAIRING ERROR:',
            error.message
          )

          pairingRequested = false
        }
      }

      if (connection === 'open') {
        console.log('Bot connected')
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode

        console.log(
          'Connection closed, code:',
          code
        )

        if (
          code !== DisconnectReason.loggedOut
        ) {
          await sleep(3000)
          start()
        } else {
          console.log(
            'Logged out. Change AUTH_DIR and relink.'
          )
        }
      }
    }
  )

  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {
      for (const message of messages) {
        try {
          if (
            !message.message ||
            message.key.fromMe
          ) {
            continue
          }

          const chatId =
            message.key.remoteJid

          // الخدمة خدامة غير فالخاص
          if (chatId.endsWith('@g.us')) {
            continue
          }

          const content =
            getMessageContent(message)

          const media =
            getMedia(content)

          if (!media) {
            const text = (
              content?.conversation ||
              content?.extendedTextMessage?.text ||
              ''
            )
              .trim()
              .toLowerCase()

            if (text === 'pdf') {
              await sock.sendMessage(
                chatId,
                {
                  text:
                    'صيفط ليا صورة أو PDF من CamScanner.'
                }
              )
            }

            continue
          }

          // PDF جاهز من CamScanner
          if (media.kind === 'pdf') {
            await sock.sendMessage(
              chatId,
              {
                text:
                  '⏳ توصلت بـPDF ديال CamScanner، كنرجعو لك بجودتو الأصلية...'
              }
            )

            const pdfBuffer =
              await downloadMedia(
                message,
                sock
              )

            await sock.sendMessage(
              chatId,
              {
                document: pdfBuffer,
                mimetype:
                  'application/pdf',
                fileName:
                  `camscanner-${Date.now()}.pdf`,
                caption:
                  '✅ توصلت بملف PDF الجاهز من CamScanner.'
              }
            )

            await sock.sendMessage(
              chatId,
              {
                text:
                  'شكراً لاستعمال الخدمة.'
              }
            )

            continue
          }

          // صورة من WhatsApp أو CamScanner
          await sock.sendMessage(
            chatId,
            {
              text:
                '⏳ توصلت بالصورة، كنقص الحواف ونصلح الميلان ونوجد PDF...'
            }
          )

          const originalBuffer =
            await downloadMedia(
              message,
              sock
            )

          const processedBuffer =
            await enhanceAndDeskewImage(
              originalBuffer
            )

          const pdfBuffer =
            await createPdfFromImage(
              processedBuffer
            )

          await sock.sendMessage(
            chatId,
            {
              document: pdfBuffer,
              mimetype:
                'application/pdf',
              fileName:
                `scanned-image-${Date.now()}.pdf`,
              caption:
                '✅ تفضل، قصيت الحواف وصلحت الميلان وحولت الصورة لـPDF.'
            }
          )

          await sock.sendMessage(
            chatId,
            {
              text:
                'شكراً لاستعمال الخدمة. إذا كانت الورقة فوق خلفية معقدة، صيفطها كـDocument باش تبقى الجودة أحسن.'
            }
          )
        } catch (error) {
          console.log(
            'MESSAGE ERROR:',
            error.message
          )

          try {
            await sock.sendMessage(
              message.key.remoteJid,
              {
                text:
                  `ماقدرتش نعالج الملف دابا. ` +
                  `السبب: ${error.message}`
              },
              {
                quoted: message
              }
            )
          } catch {}
        }
      }
    }
  )
}

start()
            
