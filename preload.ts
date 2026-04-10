const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? '999.0.0-local';
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local';
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';

// Override global feature() function to allow runtime feature gating
// This allows features disabled at compile-time to be re-enabled via environment variables
const ANT_FEATURES_ENABLED = new Set([
  'VOICE_MODE',
  'PROACTIVE',
  'KAIROS',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'MONITOR_TOOL',
  'KAIROS_PUSH_NOTIFICATION',
  'KAIROS_BRIEF',
  'KAIROS_GITHUB_WEBHOOKS',
  'HISTORY_SNIP',
  'WORKFLOW_SCRIPTS',
  'CCR_REMOTE_SETUP',
  'EXPERIMENTAL_SKILL_SEARCH',
  'ULTRAPLAN',
  'TORCH',
  'UDS_INBOX',
  'FORK_SUBAGENT',
  'DAEMON',
  'BRIDGE_MODE',
])

const EXPLICITLY_DISABLED = new Set<string>()

globalThis.feature = (name: string): boolean => {
  // Check if explicitly disabled
  if (EXPLICITLY_DISABLED.has(name)) {
    return false
  }

  // Check CLAUDE_DISABLED_FEATURES env var
  const disabledFeatures = process.env.CLAUDE_DISABLED_FEATURES?.split(',') ?? []
  if (disabledFeatures.includes(name)) {
    return false
  }

  // Check CLAUDE_ENABLED_FEATURES env var (enables specific features)
  const enabledFeatures = process.env.CLAUDE_ENABLED_FEATURES?.split(',') ?? []
  if (enabledFeatures.includes(name)) {
    return true
  }

  // Check USER_TYPE=ant (enables all ant features by default)
  if (process.env.USER_TYPE === 'ant' && ANT_FEATURES_ENABLED.has(name)) {
    return true
  }

  // Default: false
  return false
}

Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  },
});
// Switch to the current workspace
if (process.env.CALLER_DIR) {
  process.chdir(process.env.CALLER_DIR);
}
