// Aliyun NLS speech-to-text client for push-to-talk.
//
// Connects to Aliyun's one-sentence recognition (一句话识别) service via WebSocket.
// Protocol: SpeechRecognizer namespace with StartRecognition/StopRecognition
// control messages and binary PCM audio frames.
//
// Session lifecycle:
//   1. Open WS to wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1
//      with X-NLS-Token header
//   2. Send StartRecognition (text frame, JSON)
//   3. Receive RecognitionStarted
//   4. Send raw PCM audio (binary frames)
//   5. Receive RecognitionResultChanged (interim) / RecognitionCompleted (final)
//   6. Send StopRecognition (text frame, JSON)
//   7. Receive RecognitionCompleted, connection closes

import { createHmac } from 'crypto'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent } from '../utils/proxy.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { isAliyunNlsConfigured } from '../voice/voiceModeEnabled.js'

// ─── Constants ───────────────────────────────────────────────────────

const ALIYUN_NLS_WS_URL = 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1'
const ALIYUN_TOKEN_URL = 'http://nls-meta.cn-shanghai.aliyuncs.com/'

// finalize() resolution timers
export const FINALIZE_TIMEOUTS_MS = {
  safety: 8_000,
  noData: 3_000,
}

// Token cache — tokens are valid for ~24h, refresh 5min before expiry
let cachedToken: { id: string; expireTime: number } | null = null

// ─── Types ──────────────────────────────────────────────────────────

export type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}

export type FinalizeSource =
  | 'post_result'
  | 'no_data_timeout'
  | 'safety_timeout'
  | 'ws_close'
  | 'ws_already_closed'

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}

// ─── Availability ──────────────────────────────────────────────────────

export function isVoiceStreamAvailable(): boolean {
  return isAliyunNlsConfigured()
}

// ─── Alibaba Cloud POP Signature V1 ─────────────────────────────────

// RFC 3986 percent-encoding (Alibaba Cloud specific: * → %2A, ~ stays ~)
function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

async function getAliyunAccessToken(): Promise<string | null> {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET

  if (!accessKeyId || !accessKeySecret) {
    logForDebugging('[aliyun_nls] Missing AccessKeyId or AccessKeySecret')
    return null
  }

  // Return cached token if still valid (with 5min buffer)
  if (cachedToken && cachedToken.expireTime > Date.now() / 1000 + 300) {
    return cachedToken.id
  }

  try {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const nonce = randomUUID()

    const params: Record<string, string> = {
      AccessKeyId: accessKeyId,
      Action: 'CreateToken',
      Format: 'JSON',
      RegionId: 'cn-shanghai',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: nonce,
      SignatureVersion: '1.0',
      Timestamp: timestamp,
      Version: '2019-02-28',
    }

    // Step 1: Build canonicalized query string (sorted by key)
    const sortedKeys = Object.keys(params).sort()
    const canonicalized = sortedKeys
      .map(k => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
      .join('&')

    // Step 2: Build string to sign
    const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalized)}`

    // Step 3: HMAC-SHA1 with AccessKeySecret + "&"
    const hmac = createHmac('sha1', accessKeySecret + '&')
    hmac.update(stringToSign)
    const signature = hmac.digest('base64')

    // Step 4: Build final URL
    const url = `${ALIYUN_TOKEN_URL}?Signature=${percentEncode(signature)}&${canonicalized}`

    logForDebugging('[aliyun_nls] Requesting NLS access token...')
    const resp = await fetch(url)
    const body = await resp.json()

    if (body.Token?.Id) {
      cachedToken = {
        id: String(body.Token.Id),
        expireTime: body.Token.ExpireTime ?? 0,
      }
      logForDebugging(
        `[aliyun_nls] Got token, expires at ${new Date((cachedToken.expireTime) * 1000).toISOString()}`,
      )
      return cachedToken.id
    }

    logForDebugging(
      `[aliyun_nls] Token request failed: ${body.Message ?? body.ErrMsg ?? JSON.stringify(body)}`,
    )
    return null
  } catch (err) {
    logError(err)
    logForDebugging(`[aliyun_nls] Token request error: ${err}`)
    return null
  }
}

// ─── Connection ────────────────────────────────────────────────────────

export async function connectVoiceStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string; keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  const appKey = process.env.ALIYUN_NLS_APP_KEY
  if (!appKey) {
    logForDebugging('[aliyun_nls] Missing ALIYUN_NLS_APP_KEY')
    return null
  }

  const token = await getAliyunAccessToken()
  if (!token) {
    logForDebugging('[aliyun_nls] Failed to get access token')
    return null
  }

  // Generate a stable task_id for the entire session
  const taskId = randomUUID().replace(/-/g, '')

  logForDebugging(`[aliyun_nls] Connecting to ${ALIYUN_NLS_WS_URL}`)

  const tlsOptions = getWebSocketTLSOptions()
  const ws = new WebSocket(ALIYUN_NLS_WS_URL, {
    headers: {
      'X-NLS-Token': token,
    },
    agent: getWebSocketProxyAgent(ALIYUN_NLS_WS_URL),
    ...tlsOptions,
  })

  let connected = false
  let started = false // true after RecognitionStarted received
  let finalizeResolve: ((source: FinalizeSource) => void) | null = null
  let finalizeSource: FinalizeSource | null = null

  const connection: VoiceStreamConnection = {
    send: (audioChunk: Buffer) => {
      if (!connected || !started || ws.readyState !== WebSocket.OPEN) {
        return
      }
      try {
        // Aliyun NLS expects raw binary PCM frames
        ws.send(audioChunk)
      } catch (err) {
        logForDebugging(`[aliyun_nls] Send audio failed: ${err}`)
      }
    },

    finalize: () => {
      return new Promise<FinalizeSource>(resolve => {
        if (!connected || ws.readyState !== WebSocket.OPEN) {
          resolve(finalizeSource ?? 'ws_already_closed')
          return
        }

        finalizeResolve = resolve

        // Send StopRecognition
        const stopMsg = {
          header: {
            message_id: randomUUID().replace(/-/g, ''),
            task_id: taskId,
            namespace: 'SpeechRecognizer',
            name: 'StopRecognition',
            appkey: appKey,
          },
          context: {
            sdk: { name: 'claude-code', version: '1.0', language: 'typescript' },
          },
        }

        try {
          ws.send(jsonStringify(stopMsg))
          logForDebugging('[aliyun_nls] Sent StopRecognition')
        } catch (err) {
          logError(err)
          resolve(finalizeSource ?? 'ws_close')
          return
        }

        // Safety timeout — resolve even if server doesn't respond
        setTimeout(() => {
          if (finalizeResolve) {
            const r = finalizeResolve
            finalizeResolve = null
            r(finalizeSource ?? 'safety_timeout')
          }
        }, FINALIZE_TIMEOUTS_MS.safety)

        // No-data timeout — resolve if no final result arrives quickly
        setTimeout(() => {
          if (finalizeResolve && finalizeSource === null) {
            const r = finalizeResolve
            finalizeResolve = null
            r('no_data_timeout')
          }
        }, FINALIZE_TIMEOUTS_MS.noData)
      })
    },

    close: () => {
      connected = false
      started = false
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    },

    isConnected: () => connected && ws.readyState === WebSocket.OPEN,
  }

  ws.on('open', () => {
    logForDebugging('[aliyun_nls] WebSocket connected, sending StartRecognition')
    connected = true

    // Send StartRecognition
    const startMsg = {
      header: {
        message_id: randomUUID().replace(/-/g, ''),
        task_id: taskId,
        namespace: 'SpeechRecognizer',
        name: 'StartRecognition',
        appkey: appKey,
      },
      payload: {
        format: 'pcm',
        sample_rate: 16000,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
      },
      context: {
        sdk: { name: 'claude-code', version: '1.0', language: 'typescript' },
      },
    }

    try {
      ws.send(jsonStringify(startMsg))
      logForDebugging('[aliyun_nls] Sent StartRecognition')
    } catch (err) {
      logError(err)
      callbacks.onError('Failed to send StartRecognition', { fatal: true })
    }
  })

  ws.on('message', (data: Buffer | string) => {
    try {
      const message = typeof data === 'string' ? data : data.toString('utf-8')
      const parsed = jsonParse(message)
      const name = parsed.header?.name
      const status = parsed.header?.status

      logForDebugging(`[aliyun_nls] Received: ${name} status=${status}`)

      if (name === 'RecognitionStarted') {
        if (status === 20000000) {
          logForDebugging('[aliyun_nls] Recognition started successfully')
          started = true
          // Now ready to receive audio — notify caller
          callbacks.onReady(connection)
        } else {
          const errMsg = parsed.header?.status_text ?? `StartRecognition failed: ${status}`
          callbacks.onError(errMsg, { fatal: true })
        }
        return
      }

      if (name === 'RecognitionResultChanged') {
        // Intermediate result
        const result = parsed.payload?.result
        if (result) {
          logForDebugging(`[aliyun_nls] Interim: "${result}"`)
          callbacks.onTranscript(result, false)
        }
        return
      }

      if (name === 'RecognitionCompleted') {
        // Final result
        const result = parsed.payload?.result
        if (result) {
          logForDebugging(`[aliyun_nls] Final: "${result}"`)
          callbacks.onTranscript(result, true)
        }
        finalizeSource = 'post_result'
        if (finalizeResolve) {
          const r = finalizeResolve
          finalizeResolve = null
          r('post_result')
        }
        return
      }

      if (name === 'TaskFailed') {
        const errMsg = parsed.header?.status_text ?? `Task failed: ${status}`
        logForDebugging(`[aliyun_nls] TaskFailed: ${errMsg}`)
        callbacks.onError(errMsg, { fatal: true })
        return
      }
    } catch (err) {
      logForDebugging(`[aliyun_nls] Parse error: ${err}`)
    }
  })

  ws.on('error', (err: Error) => {
    logError(err)
    callbacks.onError(err.message, { fatal: true })
    connected = false
  })

  ws.on('close', () => {
    logForDebugging('[aliyun_nls] WebSocket closed')
    connected = false
    started = false
    if (finalizeSource === null) {
      finalizeSource = 'ws_close'
    }
    if (finalizeResolve) {
      const r = finalizeResolve
      finalizeResolve = null
      r(finalizeSource)
    }
    callbacks.onClose()
  })

  return connection
}
