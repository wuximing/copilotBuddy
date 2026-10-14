/**
 * The two WorkBuddy desktop apps this extension serves, ported from
 * dsh-workbuddy-connect (MIT) `variants.ts`.
 *
 * Both products write their sign-in into the *same* shared
 * `CodeBuddyExtension` auth directory — they differ by file basename, base
 * URL, catalog endpoint, and display identity. Everything that varies between
 * them lives here as one descriptor.
 */

import type { WorkBuddyRegion } from './upstream.js'

/** How one product's Electron key helper is identified on each platform. */
export interface WorkBuddyElectronProduct {
  productName: string
  /** Env var naming an explicit Electron binary for this product alone. */
  envVar: string
  macOS: { bundleId: string; defaultPath: string }
  windows: {
    displayNamePattern: RegExp
    exeBasename: string
    /** Only where the default install location has been measured (CN). */
    defaultPathSegments?: readonly string[]
  }
}

/** One WorkBuddy product variant. */
export interface WorkBuddyVariant {
  /** Vendor id registered with `vscode.lm.registerLanguageModelChatProvider`. */
  id: string
  displayName: string
  appName: string
  region: WorkBuddyRegion
  /** Env var overriding the desktop auth-file location. */
  env: string
  electron: WorkBuddyElectronProduct
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename: string
  /** Basename of the extension-owned credential copy under globalStorage. */
  ownFilename: string
  /** Basename of the extension-owned saved-catalog file under globalStorage. */
  catalogFilename: string
}

/** CN WorkBuddy first: keeps ids and copy stable. */
export const WORKBUDDY_VARIANTS: readonly WorkBuddyVariant[] = [
  {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    region: 'cn',
    env: 'WORKBUDDY_AUTH_FILE',
    electron: {
      productName: 'WorkBuddy',
      envVar: 'WORKBUDDY_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.tencent.workbuddy.mac',
        defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
      },
      windows: {
        displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'workbuddy.exe',
        defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
      },
    },
    desktopFilename: 'workbuddy-desktop.info',
    ownFilename: 'workbuddy-auth.json',
    catalogFilename: 'workbuddy-catalog.json',
  },
  {
    id: 'workbuddy-ai',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    electron: {
      productName: 'WorkBuddy AI',
      envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.workbuddy.workbuddy-ai',
        defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
      },
      windows: {
        // Measured as `WorkBuddy AI 5.6.2` / `WorkBuddy AI 5.7.6`; the exe
        // arrives as `WorkBuddyAI.exe` and is compared case-insensitively.
        displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'workbuddyai.exe',
      },
    },
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: 'workbuddy-ai-auth.json',
    catalogFilename: 'workbuddy-ai-catalog.json',
  },
]

export const CN_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[0]!
export const AI_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[1]!

export function variantFor(id: string): WorkBuddyVariant | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}
