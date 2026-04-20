import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, isKeyRelease, matchesKey } from "@mariozechner/pi-tui";
import type { VoiceShortcutMode } from "./voice-settings.ts";

export const VOICE_PUSH_TO_TALK_KEY = Key.alt("m");

export interface VoicePushToTalkEditorOptions {
  onPushToTalkStart: () => void | Promise<void>;
  onPushToTalkStop: () => void | Promise<void>;
  getSttEnabled?: () => boolean;
  getShortcut?: () => string;
  getShortcutMode?: () => VoiceShortcutMode;
}

export class VoicePushToTalkEditor extends CustomEditor {
  wantsKeyRelease = true;

  private readonly onPushToTalkStart: () => void | Promise<void>;
  private readonly onPushToTalkStop: () => void | Promise<void>;
  private readonly getSttEnabled: () => boolean;
  private readonly getShortcut: () => string;
  private readonly getShortcutMode: () => VoiceShortcutMode;
  private pushToTalkHeld = false;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    options: VoicePushToTalkEditorOptions,
  ) {
    super(tui, theme, keybindings);
    this.onPushToTalkStart = options.onPushToTalkStart;
    this.onPushToTalkStop = options.onPushToTalkStop;
    this.getSttEnabled = options.getSttEnabled || (() => true);
    this.getShortcut = options.getShortcut || (() => VOICE_PUSH_TO_TALK_KEY);
    this.getShortcutMode = options.getShortcutMode || (() => "push-to-talk");
  }

  handleInput(data: string): void {
    if (!this.getSttEnabled()) {
      if (isKeyRelease(data)) return;
      super.handleInput(data);
      return;
    }

    const shortcut = this.getShortcut();
    const shortcutMode = this.getShortcutMode();

    if (matchesKey(data, shortcut as never)) {
      if (shortcutMode === "toggle") {
        if (isKeyRelease(data)) return;
        if (this.pushToTalkHeld) {
          this.pushToTalkHeld = false;
          void this.onPushToTalkStop();
        } else {
          this.pushToTalkHeld = true;
          void this.onPushToTalkStart();
        }
        return;
      }

      const released = isKeyRelease(data);
      if (released) {
        if (this.pushToTalkHeld) {
          this.pushToTalkHeld = false;
          void this.onPushToTalkStop();
        }
        return;
      }

      if (!this.pushToTalkHeld) {
        this.pushToTalkHeld = true;
        void this.onPushToTalkStart();
      }
      return;
    }

    if (isKeyRelease(data)) {
      return;
    }

    super.handleInput(data);
  }
}
