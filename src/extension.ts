/**
 * Extension entry point: registers one `LanguageModelChatProvider` per
 * WorkBuddy variant (domestic "WorkBuddy" and international "WorkBuddy AI"),
 * a status bar item with remaining credits, and per-variant manage commands.
 */

import * as vscode from 'vscode'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AI_VARIANT, CN_VARIANT, WORKBUDDY_VARIANTS } from './variant.js'
import type { WorkBuddyVariant } from './variant.js'
import { WorkBuddyCredentialStore } from './auth.js'
import { WorkBuddyUpstreamClient } from './upstream.js'
import type { WorkBuddyCredits } from './upstream.js'
import { WorkBuddyAtRestKeyProvider } from './atrest.js'
import { WorkBuddyChatProvider } from './provider.js'

interface VariantStack {
  variant: WorkBuddyVariant
  client: WorkBuddyUpstreamClient
  store: WorkBuddyCredentialStore
  provider: WorkBuddyChatProvider
  registration: vscode.Disposable
}

interface CreditsCacheEntry {
  credits?: WorkBuddyCredits
  error?: string
}

/** Setting keys per variant. */
function settingsFor(variant: WorkBuddyVariant): { authFile: string, electronBinary: string } {
  return variant === AI_VARIANT
    ? { authFile: 'workbuddy.aiAuthFile', electronBinary: 'workbuddy.aiElectronBinary' }
    : { authFile: 'workbuddy.authFile', electronBinary: 'workbuddy.electronBinary' }
}

class CopilotBuddyExtension implements vscode.Disposable {
  private readonly stacks: VariantStack[] = []
  private readonly credits = new Map<string, CreditsCacheEntry>()
  private readonly statusBarItem: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
    this.statusBarItem.name = 'WorkBuddy'
    this.statusBarItem.command = 'copilotBuddy.refreshStatus'
    this.disposables.push(this.statusBarItem)
    this.rebuild()
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('workbuddy')) this.rebuild()
    }))
  }

  private storageDirectory(): string {
    return this.context.globalStorageUri.fsPath
  }

  private rebuild(): void {
    for (const stack of this.stacks) {
      stack.registration.dispose()
      stack.provider.dispose()
    }
    this.stacks.length = 0
    this.credits.clear()
    for (const variant of WORKBUDDY_VARIANTS) {
      const keys = settingsFor(variant)
      const config = vscode.workspace.getConfiguration()
      const authFileSetting = config.get<string>(keys.authFile) ?? ''
      const electronSetting = config.get<string>(keys.electronBinary) ?? ''
      const client = new WorkBuddyUpstreamClient()
      const store = new WorkBuddyCredentialStore({
        variant,
        ownDirectory: this.storageDirectory(),
        desktopPath: authFileSetting.trim() === '' ? undefined : authFileSetting.trim(),
        refresh: credential => client.refreshToken(credential),
        keyProvider: new WorkBuddyAtRestKeyProvider({
          product: variant.electron,
          electronPath: electronSetting.trim() === '' ? undefined : electronSetting.trim(),
        }),
      })
      const provider = new WorkBuddyChatProvider(variant, store, client, this.storageDirectory())
      const registration = vscode.lm.registerLanguageModelChatProvider(variant.id, provider)
      this.stacks.push({ variant, client, store, provider, registration })
    }
    void this.refreshStatus()
  }

  stackFor(variant: WorkBuddyVariant): VariantStack | undefined {
    return this.stacks.find(stack => stack.variant === variant)
  }

  /** Refresh sign-in state and credits for every variant, then the status bar. */
  async refreshStatus(): Promise<void> {
    for (const stack of this.stacks) {
      // Read sign-in state without refreshing tokens; a failed state still
      // updates the status bar (the reason is in the manage panel).
      await stack.provider.reload()
      const status = await stack.store.status()
      if (status.state !== 'signed-in') {
        this.credits.set(stack.variant.id, {})
        continue
      }
      try {
        const credential = await stack.store.resolve()
        const credits = await stack.client.fetchCredits(credential)
        this.credits.set(stack.variant.id, { credits })
      } catch (error: unknown) {
        this.credits.set(stack.variant.id, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.updateStatusBar()
  }

  private formatCredits(entry: CreditsCacheEntry | undefined): string {
    if (entry?.error !== undefined) return '?'
    if (entry?.credits === undefined) return '…'
    if (entry.credits.unlimited === true) return '∞'
    const total = Math.round(entry.credits.total)
    return total.toLocaleString()
  }

  private updateStatusBar(): void {
    const segments: string[] = []
    for (const stack of this.stacks) {
      const label = stack.variant === AI_VARIANT ? 'AI' : 'WB'
      const state = stack.provider.state
      const entry = this.credits.get(stack.variant.id)
      if (!state.signedIn) continue
      segments.push(`${label}·${this.formatCredits(entry)}`)
    }
    if (segments.length === 0) {
      this.statusBarItem.text = '$(plug) WorkBuddy: signed out'
    } else {
      this.statusBarItem.text = `$(bolt) ${segments.join('  ')}`
    }
    this.statusBarItem.tooltip = this.buildTooltip()
    this.statusBarItem.show()
  }

  private buildTooltip(): vscode.MarkdownString {
    const lines: string[] = ['**WorkBuddy for Copilot Chat**', '']
    for (const stack of this.stacks) {
      const state = stack.provider.state
      const entry = this.credits.get(stack.variant.id)
      lines.push(`**${stack.variant.displayName}**`)
      if (!state.signedIn) {
        lines.push(`- Status: signed out${state.reason === undefined ? '' : ` — ${state.reason}`}`)
      } else {
        lines.push(`- Status: signed in (${state.modelCount} models, catalog: ${state.catalogSource})`)
        if (entry?.error !== undefined) lines.push(`- Credits: unavailable — ${entry.error}`)
        else if (entry?.credits !== undefined) {
          const credits = entry.credits
          lines.push(credits.unlimited === true
            ? '- Credits: ∞ (enterprise, uncapped)'
            : `- Credits: ${credits.total.toLocaleString()}`)
          for (const account of credits.accounts) {
            lines.push(`  - ${account.packageName}: ${account.unlimited === true ? '∞' : account.remain.toLocaleString()} / ${account.unlimited === true ? '—' : account.size.toLocaleString()}`)
          }
          const expiry = credits.expiry
          if (expiry !== undefined && expiry.within7d.total > 0) {
            lines.push(`- Expiring within 7 days: ${expiry.within7d.total.toLocaleString()}`)
          }
          if (credits.cycleResetTime !== undefined) lines.push(`- Cycle resets: ${credits.cycleResetTime}`)
        }
      }
      lines.push('')
    }
    lines.push('$(sync) Click to refresh · models appear in the Copilot Chat model picker')
    const markdown = new vscode.MarkdownString(lines.join('\n'))
    markdown.isTrusted = false
    return markdown
  }

  /** The per-variant manage panel (wired as each provider's managementCommand). */
  async manage(variant: WorkBuddyVariant): Promise<void> {
    const stack = this.stackFor(variant)
    if (stack === undefined) return
    const state = stack.provider.state
    const entry = this.credits.get(variant.id)
    const statusLine = state.signedIn
      ? `Signed in${state.modelCount > 0 ? ` · ${String(state.modelCount)} models (${state.catalogSource})` : ''}`
      : `Signed out${state.reason === undefined ? '' : ` — ${state.reason}`}`
    const creditsLine = entry?.error !== undefined
      ? `Credits unavailable — ${entry.error}`
      : entry?.credits === undefined
        ? 'Credits: not loaded yet'
        : entry.credits.unlimited === true
          ? 'Credits: ∞ (enterprise, uncapped)'
          : `Credits: ${entry.credits.total.toLocaleString()}`
    const pick = await vscode.window.showQuickPick([
      {
        label: `$(refresh) Refresh models and credits`,
        description: 'Re-read the sign-in, catalog, and balance',
        detail: `${statusLine}\n${creditsLine}`,
        action: 'refresh',
      },
      {
        label: `$(trash) Remove this extension's stored credential copy`,
        description: 'The desktop app keeps its own sign-in; this only forgets token refreshes',
        action: 'logout',
      },
      {
        label: `$(copy) Copy diagnostics`,
        description: 'Sign-in, catalog, and credits state (never tokens) for issue reports',
        action: 'diagnostics',
      },
    ], { placeHolder: `${variant.displayName} — ${statusLine}` })
    if (pick === undefined) return
    if (pick.action === 'refresh') {
      await stack.provider.reload()
      try {
        const credential = await stack.store.resolve()
        const credits = await stack.client.fetchCredits(credential)
        this.credits.set(variant.id, { credits })
      } catch (error: unknown) {
        this.credits.set(variant.id, { error: error instanceof Error ? error.message : String(error) })
      }
      this.updateStatusBar()
      void vscode.window.showInformationMessage(`${variant.displayName}: refreshed.`)
    } else if (pick.action === 'logout') {
      await stack.store.logout()
      await stack.provider.reload()
      this.credits.set(variant.id, {})
      this.updateStatusBar()
      void vscode.window.showInformationMessage(`${variant.displayName}: the extension's stored credential copy was removed. The desktop app's own sign-in is untouched.`)
    } else if (pick.action === 'diagnostics') {
      const diagnostics = {
        extension: 'copilot-buddy',
        variant: variant.id,
        signedIn: state.signedIn,
        reason: state.reason,
        modelCount: state.modelCount,
        catalogSource: state.catalogSource,
        catalogError: state.catalogError,
        credits: entry?.credits === undefined ? undefined : {
          total: entry.credits.total,
          unlimited: entry.credits.unlimited,
          accounts: entry.credits.accounts.map(account => ({
            packageName: account.packageName,
            remain: account.remain,
            size: account.size,
          })),
        },
        creditsError: entry?.error,
        desktopAuthPath: stack.store.desktopAuthPath(),
        electronHelperPath: 'see settings',
      }
      await vscode.env.clipboard.writeText(JSON.stringify(diagnostics, null, 2))
      void vscode.window.showInformationMessage(`${variant.displayName}: diagnostics copied to the clipboard (no tokens included).`)
    }
  }

  dispose(): void {
    for (const stack of this.stacks) {
      stack.registration.dispose()
      stack.provider.dispose()
    }
    this.stacks.length = 0
    for (const disposable of this.disposables) disposable.dispose()
  }
}

let extension: CopilotBuddyExtension | undefined

export function activate(context: vscode.ExtensionContext): void {
  void mkdir(join(context.globalStorageUri.fsPath), { recursive: true }).catch(() => {})
  extension = new CopilotBuddyExtension(context)
  context.subscriptions.push(
    extension,
    vscode.commands.registerCommand('copilotBuddy.manage', () => extension?.manage(CN_VARIANT)),
    vscode.commands.registerCommand('copilotBuddy.manageAI', () => extension?.manage(AI_VARIANT)),
    vscode.commands.registerCommand('copilotBuddy.refreshStatus', () => extension?.refreshStatus()),
  )
}

export function deactivate(): void {
  extension = undefined
}
