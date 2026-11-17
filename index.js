import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import { PDFDocument } from 'pdf-lib'

const AUTH_DIR = process.env.AUTH_DIR || './auth'
const PHONE = (process.env.PHONE || '').replace(/[^0-9]/g, '')
const PDF_PAGE_SIZE = (process.env.PDF_PAGE_SIZE || 'A4').toUpperCase()
const logger = pino({ level: 'silent' })

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms))

function ensureDirectories() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
}

function getMessageContent(message) {
  return (
    normalizeMessageContent(message.message) ||
    message.message
  )
}

function detectImageType(buffer, mimetype = '') {
  const mime = mimetype
    .split(';')[0]
    .toLowerCase()

  const isPng =
    mime === 'image/png' ||
    buffer.subarray(0, 8).equals(
      Buffer.from([
        137, 80, 78, 71,
        13, 10, 26, 10
      ])
    )

  if (isPng) return 'png'

  const isJpg =
    mime === 'image/jpeg' ||
    (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8
    )

  if (isJpg) return 'jpg'

  return null
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

async function downloadImage(message, sock) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          'تحميل الصورة خذا وقت طويل بزاف، عاود صيفطها من فضلك.'
        )
      )
    }, 30000)
  })

  const download = downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger,

      // إعادة طلب رابط الصورة إذا كان منتهي
      reuploadRequest: oldMessage =>
        sock.updateMediaMessage(oldMessage)
    }
  )

  return Promise.race([
    download,
    timeout
  ])
}

async function createPdfFromImage(
  buffer,
  mimetype
) {
  const type = detectImageType(
    buffer,
    mimetype
  )

  if (!type) {
    throw new Error(
      'خاص الصورة تكون JPG أو PNG.'
    )
  }

  const pdfDoc =
    await PDFDocument.create()

  pdfDoc.setTitle('WhatsApp Image')
  pdfDoc.setProducer(
    'WhatsApp Image to PDF Bot'
  )

  // إدخال الصورة بلا إعادة ضغط JPEG
  const image = type === 'png'
    ? await pdfDoc.embedPng(buffer)
    : await pdfDoc.embedJpg(buffer)

  const dimensions = image.scale(1)
  const pageSize = getPageSize()

  // PDF_PAGE_SIZE=ORIGINAL
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
    const [pageWidth, pageHeight] =
      pageSize

    const fitted = fitInside(
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
      x: (pageWidth - fitted.width) / 2,
      y: (pageHeight - fitted.height) / 2,
      width: fitted.width,
      height: fitted.height
    })
  }

  const bytes = await pdfDoc.save({
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

          const image =
            content?.imageMessage

          // إذا كتب pdf بلا صورة
          if (!image) {
            const text = (
              content?.conversation ||
              content?.extendedTextMessage?.text ||
              ''
            ).trim().toLowerCase()

            if (text === 'pdf') {
              await sock.sendMessage(
                chatId,
                {
                  text:
                    'صيفط ليا صورة، وأنا نحولها مباشرة لـPDF.'
                }
              )
            }

            continue
          }

          // إشعار فوري للمستخدم
          await sock.sendMessage(
            chatId,
            {
              text:
                '⏳ توصلت بالصورة، كنوجد لك PDF بجودة عالية...'
            }
          )

          const imageBuffer =
            await downloadImage(
              message,
              sock
            )

          const pdfBuffer =
            await createPdfFromImage(
              imageBuffer,
              image.mimetype || 'image/jpeg'
            )

          // إرسال ملف PDF مباشرة
          await sock.sendMessage(
            chatId,
            {
              document: pdfBuffer,
              mimetype: 'application/pdf',
              fileName:
                `image-${Date.now()}.pdf`,
              caption:
                '✅ تفضل، حوّلت الصورة ديالك إلى PDF بجودة عالية.'
            }
          )

          // رسالة الشكر
          await sock.sendMessage(
            chatId,
            {
              text:
                'شكراً لاستعمال الخدمة. نتمنى يعجبك الـPDF.'
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
                  `ماقدرتش نحول الصورة دابا. ` +
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
