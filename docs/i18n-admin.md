# Admin i18n Coverage

This document tracks which admin panels in webapp/admin/index.js are localized with t('admin.*') keys.

## Completed in this pass

- About panel
- Telemetry panel
- Server Audio panel
- Transcode panel
- Federation panel
- Database panel search/queue/shared-playlists actions
- Genre Groups panel
- Artists admin panel
- Scan Errors panel

## Key conventions

- Use t('admin.section.key') in templates.
- Keep reusable labels under admin.common.*.
- For dynamic strings, use params (example: admin.serverAudio.detectFound with {{version}} and {{path}}).
- Keep all 12 locale files in sync after adding keys.
- Locale activation must validate JSON before switching; invalid locale files must be rejected and the UI must stay on the previous valid language.

## Added key groups

- admin.info.telemetry*
- admin.serverAudio.subtitleMpv, remoteHint, detect*, confirm*
- admin.transcode.editInConfig, pending, confirm*
- admin.federation.btnAcceptInvite, btnWorking, confirm*, toastEnabled/toastDisabled
- admin.common.enable, disable, yes, no

## Related player i18n completed

- Front index search placeholders are localized in `webapp/app.js`:
	- artist index search
	- album library search
	- albums index search
- Shared i18n engine behavior:
	- locale JSON is validated before activation in player and admin
	- invalid locale files trigger an error message and do not replace the active language
- Language switcher UI:
	- player and admin now use compact flag buttons instead of dropdown selects
	- buttons render real country flag icons (with emoji fallback only on image load failure)
	- admin now also filters visible flags via `/api/v1/languages/enabled`, matching player behavior
	- language changes are synchronized across open tabs (admin and player) through localStorage `velvet-lang` updates
	- the active language is highlighted, and failed activation rolls back the highlighted flag to the previous valid language

## File explorer localization

- The admin file-explorer modal now uses localized titles, navigation labels, and toast messages via `admin.modal.browse*` keys.
- The player shell bootstrap moved out of inline HTML scripts so manifest and locale-picker boot code run without inline-script CSP violations. (Note: player entry routes allow route-scoped `unsafe-eval` for Butterchurn preset compilation.)
