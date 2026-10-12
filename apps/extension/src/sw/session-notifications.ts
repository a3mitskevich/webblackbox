import { EXTENSION_FILES } from "../shared/extension-files.js";
import type { SessionRuntime } from "./session-registry.js";

/**
 * System notifications for what the tester must not miss while the popup is closed: a stopped
 * recording that waits for its export (clicking opens the sessions page on its export), and a
 * recording that left Full and goes on in Light. Texts come from `_locales` (`chrome.i18n`).
 */

const EXPORT_NOTIFICATION_PREFIX = "webblackbox.export:";
const FALLBACK_NOTIFICATION_PREFIX = "webblackbox.fallback:";
const ICON_PATH = "icon/128.png";

export type NotificationsApiLike = {
  create(
    notificationId: string,
    options: { type: "basic"; iconUrl: string; title: string; message: string; priority?: number }
  ): Promise<string> | void;
  clear(notificationId: string): Promise<boolean> | void;
  onClicked: { addListener(callback: (notificationId: string) => void): void };
};

export type SessionNotificationsDeps = {
  notifications: NotificationsApiLike | undefined;
  getMessage: (key: string) => string;
  getURL: (path: string) => string;
  /** The popup is open: it shows the export step itself. */
  isPopupOpen: () => boolean;
  openTab: (url: string) => Promise<void>;
};

export type SessionNotifications = {
  notifyExportPending: (runtime: SessionRuntime) => void;
  notifyCaptureFallback: (runtime: SessionRuntime) => void;
  clear: (sid: string) => void;
};

/** `sessions.html` opened on the export of one recording. */
export function exportPagePath(sid: string): string {
  return `${EXTENSION_FILES.sessionsPage}#export=${encodeURIComponent(sid)}`;
}

export function createSessionNotifications(deps: SessionNotificationsDeps): SessionNotifications {
  deps.notifications?.onClicked.addListener((notificationId) => {
    const sid = notificationId.startsWith(EXPORT_NOTIFICATION_PREFIX)
      ? notificationId.slice(EXPORT_NOTIFICATION_PREFIX.length)
      : null;

    void Promise.resolve(deps.notifications?.clear(notificationId)).catch(() => undefined);

    if (sid) {
      void deps.openTab(deps.getURL(exportPagePath(sid))).catch((error: unknown) => {
        console.warn("[WebBlackbox] failed to open the export page", error);
      });
    }
  });

  function show(notificationId: string, titleKey: string, messageKey: string): void {
    const title = deps.getMessage(titleKey);
    const message = deps.getMessage(messageKey);

    if (!deps.notifications || !title || !message) {
      return;
    }

    void Promise.resolve(
      deps.notifications.create(notificationId, {
        type: "basic",
        iconUrl: deps.getURL(ICON_PATH),
        title,
        message,
        priority: 2
      })
    ).catch((error: unknown) => {
      console.warn("[WebBlackbox] failed to show a notification", error);
    });
  }

  return {
    notifyExportPending: (runtime) => {
      if (!deps.isPopupOpen()) {
        show(
          `${EXPORT_NOTIFICATION_PREFIX}${runtime.sid}`,
          "notifyExportTitle",
          "notifyExportMessage"
        );
      }
    },
    notifyCaptureFallback: (runtime) => {
      show(
        `${FALLBACK_NOTIFICATION_PREFIX}${runtime.sid}`,
        "notifyFallbackTitle",
        "notifyFallbackMessage"
      );
    },
    clear: (sid) => {
      for (const prefix of [EXPORT_NOTIFICATION_PREFIX, FALLBACK_NOTIFICATION_PREFIX]) {
        void Promise.resolve(deps.notifications?.clear(`${prefix}${sid}`)).catch(() => undefined);
      }
    }
  };
}
