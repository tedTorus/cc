import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

// Try to load compile-time feature macro; fall back to no-op if unavailable
let _feature: (name: string) => boolean = () => false
try {
  _feature = require('bun:bundle').feature ?? (() => false)
} catch {}

/**
 * Runtime check for VOICE_MODE feature gate.
 * Handles both compile-time feature() macro and runtime environment variables.
 */
export function isVoiceFeatureGated(): boolean {
  // First try compile-time macro (if not dead-coded away)
  if (_feature('VOICE_MODE')) {
    return true
  }

  // Fallback to environment variables for runtime override
  if (process.env.CLAUDE_DISABLED_FEATURES?.includes('VOICE_MODE')) {
    return false
  }

  if (process.env.CLAUDE_ENABLED_FEATURES?.includes('VOICE_MODE')) {
    return true
  }

  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  return false
}

/**
 * Kill-switch check for voice mode. Returns true unless the
 * `tengu_amber_quartz_disabled` GrowthBook flag is flipped on (emergency
 * off). Default `false` means a missing/stale disk cache reads as "not
 * killed" — so fresh installs get voice working immediately without
 * waiting for GrowthBook init. Use this for deciding whether voice mode
 * should be *visible* (e.g., command registration, config UI).
 */
export function isVoiceGrowthBookEnabled(): boolean {
  // Positive ternary pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  return isVoiceFeatureGated()
    ? !getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)
    : false
}

/**
 * Check if Aliyun NLS is properly configured
 */
export function isAliyunNlsConfigured(): boolean {
  return Boolean(
    process.env.ALIYUN_NLS_APP_KEY &&
    process.env.ALIYUN_ACCESS_KEY_ID &&
    process.env.ALIYUN_ACCESS_KEY_SECRET
  )
}

/**
 * Auth check for voice mode: Aliyun NLS configuration
 * No OAuth requirement - just need Aliyun credentials
 */
export function hasVoiceAuth(): boolean {
  return isAliyunNlsConfigured()
}

/**
 * Full runtime check: auth + GrowthBook kill-switch. Callers: `/voice`
 * (voice.ts, voice/index.ts), ConfigTool, VoiceModeNotice — command-time
 * paths where a fresh keychain read is acceptable. For React render
 * paths use useVoiceEnabled() instead (memoizes the auth half).
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}
