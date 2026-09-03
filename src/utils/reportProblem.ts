/**
 * "Report this document" — the channel every engine fix has come through.
 *
 * Each content-stream bug this editor has fixed started from ONE real PDF a
 * user could not edit. The failures are silent and generator-specific, so a
 * description alone is useless; the file is what is needed. The report is a
 * pre-filled email: no backend, works on any host, and the user attaches the
 * PDF themselves — nothing from the document's content is put in the message,
 * only the error the status bar showed, the file name, the page and the app
 * version.
 */
import { version as APP_VERSION } from '../../package.json'

export const SUPPORT_EMAIL = 'editorpdfpro@gmail.com'

/**
 * Does this status line describe an edit the engine REFUSED or that failed?
 *
 * Matched on the phrases the engine and the overlays actually emit: "Could not
 * find matching text", "Could not be moved", "Cannot encode characters",
 * "Transform failed", "Error: …", "could not be shifted", "may still overlap".
 * Progress and success lines never carry them.
 */
export function isRefusal(status: string): boolean {
  return /\b(could not|cannot|can't|failed|error|not supported|no matching|may still overlap|unreadable)\b/i.test(status)
}

export interface ReportContext {
  status: string
  fileName: string | null
  page: number
  pages: number
}

/** A `mailto:` URL with subject and body filled in. */
export function buildReportMailto(ctx: ReportContext): string {
  const subject = `PDF Editor Pro: ${ctx.status.slice(0, 80)}`
  const body = [
    'Hello,',
    '',
    'I could not edit this document. The PDF is attached.',
    '',
    `Message shown: ${ctx.status}`,
    `File: ${ctx.fileName ?? '(none open)'}`,
    `Page: ${ctx.page} of ${ctx.pages}`,
    `App version: ${APP_VERSION}`,
    `Browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
    `URL: ${typeof location !== 'undefined' ? location.href : ''}`,
    '',
    'What I was trying to do:',
    '',
    '',
    '(Please attach the PDF — the file is used only to reproduce and fix the problem, then deleted.)',
  ].join('\n')
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
