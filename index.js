import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { PDFDocument } from 'pdf-lib'

const AUTH_DIR = process.env.AUTH_DIR || './auth'
const DATA_DIR = process.env.DATA_DIR || './data'
const IMAGE_DIR = path.join(DATA_DIR, 'images')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const PHONE = (process.env.PHONE || '').replace(/[^0-9]/g, '')

const MAX_IMAGES = Math.min(
  100,
  Math.max(1, Number.parseInt(process.env.MAX_IMAGES || '50', 10) || 50)
)

const PDF_PAGE_SIZE = (process.env.PDF_PAGE_SIZE || 'A4').toUpperCase()
const logger = pino({ level: 'silent' })
const sessions = new Map()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function ensureDirectories() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return

    const saved = JSON.parse(
      fs.readFileSync(SESSIONS_FILE, 'utf8')
    )

    for (const [chatId, items] of Object.entries(saved)) {
      if (Array.isArray(items)) {
        sessions.set(
          chatId,
          items.filter(item =>
            item?.filePath &&
            fs.existsSync(item.filePath)
          )
        )
      }
    }

    console.log('Loaded image sessions:', sessions.size)
  } catch (error) {
    console.log('SESSION LOAD ERROR:', error.message)
  }
}

async function saveSessions() {
  await fs.promises.mkdir(DATA_DIR, {
    recursive: true
  })

  await fs.promises.writeFile(
    SESSIONS_FILE,
    JSON.stringify(
      Object.fromEntries(sessions),
      null,
      2
    ),
    'utf8'
  )
}

function getText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    ''
  ).trim()
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

  if (PDF_PAGE_SIZE === 'A4') {
    return [595.28, 841.89]
  }

  // استعمل PDF_PAGE_SIZE=ORIGINAL
  // باش كل صفحة تكون بحجم الصورة الأصلية
  return null
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

async function addImageToPdf(pdfDoc, item) {
  const buffer = await fs.promises.readFile(
    item.filePath
  )

  const type =
    item.type ||
    detectImageType(buffer, item.mimetype)

  if (!type) {
    throw new Error(
      'Only JPEG and PNG images are supported'
    )
  }

  const image = type === 'png'
    ? await pdfDoc.embedPng(buffer)
    : await pdfDoc.embedJpg(buffer)

  const dimensions = image.scale(1)
  const fixedPage = getPageSize()

  // إذا كانت الصفحة ORIGINAL
  if (!fixedPage) {
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

    return
  }

  const [pageWidth, pageHeight] = fixedPage
  const margin = 0

  const fitted = fitInside(
    dimensions.width,
    dimensions.height,
    pageWidth - margin * 2,
    pageHeight - margin * 2
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

async function createPdf(chatId) {
  const items = sessions.get(chatId) || []

  if (!items.length) {
    return null
  }

  const pdfDoc = await PDFDocument.create()

  pdfDoc.setTitle('WhatsApp Images')
  pdfDoc.setProducer(
    'WhatsApp Image to PDF Bot'
  )

  for (const item of items) {
    await addImageToPdf(pdfDoc, item)
  }

  const bytes = await pdfDoc.save({
    useObjectStreams: true
  })

  const outputPath = path.join(
    DATA_DIR,
    `images-${safeId(chatId)}-${Date.now()}.pdf`
  )

  await fs.promises.writeFile(
    outputPath,
    bytes
  )

  return {
    outputPath,
    count: items.length
  }
}

async function clearSession(chatId) {
  const items = sessions.get(chatId) || []

  for (const item of items) {
    try {
      await fs.promises.unlink(
        item.filePath
      )
    } catch {}
  }

  sessions.delete(chatId)
  await saveSessions()
}

async function addImage(
  chatId,
  message,
  sock
) {
  const image =
    message.message.imageMessage

  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger,

      // إعادة طلب رابط الصورة إذا كان منتهي
      reuploadRequest: sock.updateMediaMessage
    }
  )

  const type = detectImageType(
    buffer,
    image.mimetype
  )

  if (!type) {
    throw new Error(
      'Only JPEG and PNG images are supported'
    )
  }

  const existing =
    sessions.get(chatId) || []

  if (existing.length >= MAX_IMAGES) {
    throw new Error(
      `Maximum ${MAX_IMAGES} images per PDF`
    )
  }

  const filename =
    `${safeId(chatId)}-` +
    `${Date.now()}-` +
    `${existing.length + 1}.` +
    `${type === 'jpg' ? 'jpg' : 'png'}`

  const filePath = path.join(
    IMAGE_DIR,
    filename
  )

  await fs.promises.writeFile(
    filePath,
    buffer
  )

  existing.push({
    filePath,
    type,
    mimetype:
      image.mimetype || `image/${type}`,
    createdAt:
      new Date().toISOString()
  })

  sessions.set(chatId, existing)

  await saveSessions()

  return existing.length
}

async function start() {
  ensureDirectories()
  loadSessions()

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

          // البوت يخدم غير فالخاص
          if (chatId.endsWith('@g.us')) {
            continue
          }

          const image =
            message.message.imageMessage

          const text =
            getText(message).toLowerCase()

          // استقبال الصورة وتخزينها
          if (image) {
            const count =
              await addImage(
                chatId,
                message,
                sock
              )

            await sock.sendMessage(
              chatId,
              {
                text:
                  `✅ تسجلات الصورة رقم ${count}. ` +
                  `صيفط صور أخرى، ومنين تسالي كتب: pdf`
              },
              {
                quoted: message
              }
            )

            continue
          }

          // مسح الصور
          if (
            [
              'مسح',
              'clear',
              'reset',
              'الغاء',
              'إلغاء'
            ].includes(text)
          ) {
            await clearSession(chatId)

            await sock.sendMessage(
              chatId,
              {
                text:
                  '🗑️ تم مسح الصور المجمعة.'
              },
              {
                quoted: message
              }
            )

            continue
          }

          // إنشاء وإرسال PDF
          if (
            [
              'pdf',
              'تحويل pdf',
              'حول pdf',
              'صايب pdf',
              'صنع pdf'
            ].includes(text)
          ) {
            const items =
              sessions.get(chatId) || []

            if (!items.length) {
              await sock.sendMessage(
                chatId,
                {
                  text:
                    'مازال ما صيفطتي حتى صورة. ' +
                    'صيفط الصور أولاً.'
                },
                {
                  quoted: message
                }
              )

              continue
            }

            await sock.sendMessage(
              chatId,
              {
                text:
                  `⏳ كنوجد PDF من ` +
                  `${items.length} صورة...`
              },
              {
                quoted: message
              }
            )

            const result =
              await createPdf(chatId)

            // إرسال PDF مباشرة للمستخدم
            await sock.sendMessage(
              chatId,
              {
                document: {
                  url: result.outputPath
                },
                mimetype: 'application/pdf',
                fileName:
                  `images-${Date.now()}.pdf`,
                caption:
                  `✅ تفضل، الـPDF ديالك واجد ` +
                  `بجودة أصلية من ` +
                  `${result.count} صورة.`
              }
            )

            // رسالة الشكر
            await sock.sendMessage(
              chatId,
              {
                text:
                  'شكراً لاستعمال الخدمة. ' +
                  'نتمنى يعجبك الـPDF.'
              }
            )

            // مسح الصور من بعد الإرسال
            await clearSession(chatId)

            try {
              await fs.promises.unlink(
                result.outputPath
              )
            } catch {}
          }
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
                  `وقع مشكل: ${error.message}`
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
            
