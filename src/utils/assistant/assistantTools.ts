import type { ToolDefinition } from './openaiClient'

/**
 * What the editing assistant may do to the document, as the model sees it.
 *
 * Every tool maps onto an engine call the UI already makes (see
 * useAssistant.ts for the executor). References like `b12` / `r3` come from
 * the page listing the model was shown; they are ANCHORS (text + position)
 * resolved fresh before each call, because block ids are renumbered by every
 * edit. Coordinates are stated once here, in page space — top-left origin,
 * y down, points — and the executor converts to whatever each engine call
 * wants; the model never has to know the content stream's y goes up.
 */
export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_page_text',
      description: 'List the text on a page as references ([b12] "text" …) with positions. Call it when the page you need is not the one already listed, or after edits when you need fresh references.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer', description: '1-based page number' } },
        required: ['page']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_text',
      description: 'Search the whole document for a string (case-insensitive). Returns the page, the reference and the full text of each block that contains it.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_page',
      description: 'Replace a phrase with new text on a page, even when the phrase spans several lines or table cells. This is the PREFERRED way to change any run of words the user names — you do not need to know which block it falls in. By default it changes EVERY occurrence on the page; pass occurrence:"first" only when the user singled one out. "find" must be the exact words as they appear (case-insensitive, spacing ignored). To delete a phrase, pass an empty "replace".',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'integer', description: '1-based page number' },
          find: { type: 'string', description: 'The exact existing words to replace' },
          replace: { type: 'string', description: 'The new text ("" to delete the phrase)' },
          occurrence: { type: 'string', enum: ['all', 'first'], description: 'Which occurrences to change (default "all")' }
        },
        required: ['page', 'find', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_document',
      description: 'Replace a phrase EVERYWHERE in the document, across all pages, in one call. Handles text pages and scanned pages (it recognises the scanned ones itself). Use this when the user says "in the whole document", "everywhere", "en todo el documento", or otherwise wants every page changed. Returns a per-page report.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'The exact existing words to replace' },
          replace: { type: 'string', description: 'The new text ("" to delete the phrase)' }
        },
        required: ['find', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_text',
      description: 'Replace the ENTIRE text of ONE listed block/line with new text. Use this only when you deliberately want to rewrite a single whole block; for changing a word or phrase, prefer replace_in_page. Keeps the font, size, colour and position.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'A reference from the listing, e.g. "b12" or "r3"' },
          new_text: { type: 'string' }
        },
        required: ['ref', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_text',
      description: 'Remove one or more text blocks from the page.',
      parameters: {
        type: 'object',
        properties: { refs: { type: 'array', items: { type: 'string' } } },
        required: ['refs']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_text',
      description: 'Move text blocks by an offset in points. dx > 0 moves right, dy > 0 moves DOWN the page.',
      parameters: {
        type: 'object',
        properties: {
          refs: { type: 'array', items: { type: 'string' } },
          dx: { type: 'number' },
          dy: { type: 'number' }
        },
        required: ['refs', 'dx', 'dy']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'restyle_text',
      description: 'Change the size, colour or font family of text blocks. Only the given properties change.',
      parameters: {
        type: 'object',
        properties: {
          refs: { type: 'array', items: { type: 'string' } },
          font_size: { type: 'number', description: 'Point size' },
          color: { type: 'string', description: 'Hex colour like #ff0000' },
          font: { type: 'string', enum: ['Helvetica', 'Times-Roman', 'Courier'] }
        },
        required: ['refs']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_text',
      description: 'Write new text onto a page at a position. x,y are in points from the top-left corner of the page; y is the TOP of the text. Use the positions in the listing to place text relative to existing lines (e.g. just below a line: its y + its height + 2).',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          x: { type: 'number' },
          y: { type: 'number' },
          text: { type: 'string' },
          font_size: { type: 'number', description: 'Default 11' },
          color: { type: 'string', description: 'Hex colour, default #000000' },
          bold: { type: 'boolean' }
        },
        required: ['page', 'x', 'y', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'highlight_text',
      description: 'Highlight every occurrence of a string on a page with a translucent colour (a highlight annotation).',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          text: { type: 'string' },
          color: { type: 'string', description: 'Hex colour, default yellow #ffeb3b' }
        },
        required: ['page', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_note',
      description: 'Add a sticky-note comment at a position on a page (x,y in points from the top-left).',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          x: { type: 'number' },
          y: { type: 'number' },
          text: { type: 'string' }
        },
        required: ['page', 'x', 'y', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rotate_page',
      description: 'Rotate a page by 90 or -90 degrees.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer' }, degrees: { type: 'integer', enum: [90, -90, 180] } },
        required: ['page', 'degrees']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_page',
      description: 'Delete a page. Only call it after the user has explicitly confirmed which page.',
      parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'duplicate_page',
      description: 'Duplicate a page (the copy goes right after it).',
      parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_blank_page',
      description: 'Insert a blank page after the given page (same size).',
      parameters: { type: 'object', properties: { after_page: { type: 'integer' } }, required: ['after_page'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_page',
      description: 'Move a page to another position.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer' }, to: { type: 'integer', description: 'New 1-based position' } },
        required: ['page', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'go_to_page',
      description: 'Show a page to the user.',
      parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recognize_page',
      description: 'Run OCR on a scanned page so its text can be listed and edited. Takes 10-45 seconds.',
      parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undo',
      description: 'Undo the last change to the document.',
      parameters: { type: 'object', properties: {} }
    }
  }
]

export const ASSISTANT_SYSTEM_PROMPT = `You are the editing assistant inside a PDF editor. The user tells you in plain language what to change in the open document and you make the change by calling tools. You edit the document DIRECTLY: every successful tool call is already applied and visible to the user, and each one can be undone with Ctrl+Z.

How to work:
- The text of the page the user is looking at is listed for you before each message as references like [b12] "text" (x,y,w,h in points, top-left origin). Use those references. If the text the user means is on another page, or you need fresh references after an edit on the same page, call list_page_text or find_text first.
- To change or remove a word or phrase the user names, prefer replace_in_page(page, find, replace): give the EXACT existing words as "find" and the new text as "replace". It handles a phrase that spans several lines or table cells (extraction splits a paragraph into one block per line, so "MEJORAMIENTO DE LA SALA DE COMUNICACIONES" may start on one line and finish on the next). Do not split such a change into per-line replace_text calls — that leaves fragments behind.
- replace_in_page changes EVERY occurrence of the phrase on that page by default (a name or date repeated through a form is usually meant to change everywhere), and tells you how many it changed. Add occurrence:"first" only when the user pointed at one specific place.
- When the user wants a change across the WHOLE document ("en todo el documento", "everywhere", "in all pages"), call replace_in_document(find, replace) ONCE — it changes every page, recognises scanned pages itself, and returns a per-page report. Do not loop replace_in_page page by page for this; that is what left a page unedited before.
- replace_text replaces one whole listed block; use it only when you specifically mean to rewrite a single line/cell in full.
- Do only what the user asked. Do not "improve" other text. When the request is ambiguous (several matching lines, or it is not clear which page), ask a short question instead of guessing.
- Deleting a whole page needs the user's explicit confirmation; text edits do not.
- SCANNED PAGES: some pages are scanned images (a signed copy, a photo). Their text is part of the picture and cannot be edited directly — the listing, or find_text, will say the page is scanned or needs recognition. When a page you need to edit is scanned, call recognize_page(N) YOURSELF and then edit the "r" references it returns (e.g. p3r9); the change shows at once and is written into the file when the user saves. Do NOT end your turn telling the user that the text is an image or that they must recognise it — you can recognise it, so do it. The same document can have real text pages and scanned pages; edit each the right way.
- "en esta página" / "this page" means the page the user is looking at (given at the top of the context). If that page is scanned, recognise it and edit its r-references — do not search the whole document.
- find_text may report the same words on several pages, some real text and some scanned. Recognise the scanned pages you actually need, then edit them.
- After the tools have run, answer in one or two short sentences saying what you changed (or why you could not). Reply in the SAME language the user wrote their latest message in (they may switch languages between messages); use Spanish only when that is unclear. Do not list tool names or references to the user.
- If a tool reports an error, say so plainly; do not retry the same call more than once.`
