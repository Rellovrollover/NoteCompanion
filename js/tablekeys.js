// Table keys, the OneNote way (Microsoft's "Work with tables" shortcuts):
//   Tab at the end of a line of text      → makes a table: that text in the first cell, the cursor in the second
//   Tab in the last cell of a one-row table → adds a column (in bigger tables Tab moves on, adding a row at the end)
//   Enter at the end of a last-column cell  → adds a row below; Enter on an empty last row finishes the table
//   Enter at the start of a row             → adds a row above (not on the first row)
//   Ctrl+Enter                              → adds a row below the current one
//   Alt+Enter                               → a new line in the same cell
//   Ctrl+Alt+R / Ctrl+Alt+E                 → adds a column to the right / left
//   Delete, Delete at the start of an empty row → deletes the row
//   Arrow keys                              → move cell to cell (left/right at the ends of a cell, up/down by column)
(function () {
  const BLANK = /[\s ​﻿]/g;
  function attach(ed, changed) {
    const doc = () => ed.getDoc();
    const cellOf = (n) => ed.dom.getParent(n, 'td,th');
    const ownTable = (n) => ed.dom.getParent(n, 'table');
    const empty = (el) => !el.textContent.replace(BLANK, '') && !el.querySelector('img,table,hr,iframe,video,audio,input');
    const rowsOf = (t) => [...t.rows];
    // Is the caret at the very start / end of `el` (ignoring blank space)?
    function edge(el, atEnd) {
      const r = ed.selection.getRng(); if (!r.collapsed || !el.contains(r.startContainer)) return false;
      const x = doc().createRange();
      if (atEnd) { x.setStart(r.endContainer, r.endOffset); x.setEnd(el, el.childNodes.length); } else { x.setStart(el, 0); x.setEnd(r.startContainer, r.startOffset); }
      const frag = x.cloneContents();
      return !frag.textContent.replace(BLANK, '') && !(frag.querySelector && frag.querySelector('img,table,hr,iframe,video,audio'));
    }
    function place(el, atEnd) { ed.selection.select(el, true); ed.selection.collapse(!atEnd); ed.selection.scrollIntoView(); }
    function done() { ed.nodeChanged(); ed.undoManager.add(); changed && changed(); }
    // A table as a grid, with merged cells repeated, so up/down keep to the same column.
    function grid(t) {
      const map = [];
      rowsOf(t).forEach((tr, r) => {
        map[r] = map[r] || []; let c = 0;
        for (const td of tr.cells) {
          while (map[r][c]) c++;
          const rs = Math.max(1, td.rowSpan || 1), cs = Math.max(1, td.colSpan || 1);
          for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) { map[r + i] = map[r + i] || []; map[r + i][c + j] = td; }
          c += cs;
        }
      });
      return map;
    }
    function posOf(map, td) { for (let r = 0; r < map.length; r++) { const c = (map[r] || []).indexOf(td); if (c >= 0) return [r, c]; } return null; }
    const allCells = (t) => rowsOf(t).flatMap((tr) => [...tr.cells]);
    // Run a table-plugin command with the caret in `td`, then put the caret where `pick(rows, ri, ci)` says. The plugin
    // may rebuild the table and moves the caret itself, so the target is found by position in the table afterwards.
    function run(td, name, pick) {
      const tr = td.parentNode, ri = rowsOf(ownTable(td)).indexOf(tr), ci = [...tr.cells].indexOf(td);
      ed.undoManager.transact(() => {
        place(td, true); ed.execCommand(name);
        const now = cellOf(ed.selection.getNode()); const t = now ? ownTable(now) : null; if (!t) return;
        const rows = rowsOf(t), c = pick(rows, ri, ci);
        if (c) place(c, false);
      });
      done();
    }
    const cellAt = (rows, r, c) => { const tr = rows[Math.max(0, Math.min(r, rows.length - 1))]; return tr ? tr.cells[Math.max(0, Math.min(c, tr.cells.length - 1))] : null; };

    // ---- making a table from a line of text ----
    function lineToTable() {
      const r = ed.selection.getRng(); if (!r.collapsed) return false;
      const block = ed.dom.getParent(ed.selection.getNode(), 'p,div', ed.getBody());
      if (!block || block.tagName !== 'P' || ed.dom.getParent(block, 'li,td,th,pre,summary,table', ed.getBody())) return false;
      if (empty(block) || !edge(block, true)) return false;
      ed.undoManager.transact(() => {
        const table = ed.dom.create('table', { class: 'nc-auto' });
        const tbody = ed.dom.create('tbody'), tr = ed.dom.create('tr');
        const a = ed.dom.create('td'), b = ed.dom.create('td', {}, '<br data-mce-bogus="1">');
        while (block.firstChild) a.appendChild(block.firstChild);
        // Trailing spaces typed before the Tab don't belong in the cell.
        const last = a.lastChild; if (last && last.nodeType === 3) last.nodeValue = last.nodeValue.replace(/[\s ]+$/, '');
        tr.append(a, b); tbody.append(tr); table.append(tbody);
        block.parentNode.replaceChild(table, block);
        if (!table.nextSibling) table.after(ed.dom.create('p', {}, '<br data-mce-bogus="1">'));
        place(b, false);
      });
      done(); return true;
    }

    // ---- Delete, Delete on an empty row ----
    let armed = null;
    const disarm = () => { if (!armed) return; for (const c of armed.cells) c.removeAttribute('data-mce-selected'); armed = null; };

    // Slash commands and symbol codes use Enter / Tab to pick from their pop-up: leave those keys to them.
    let menuOpen = false;
    ed.on('AutocompleterStart AutocompleterUpdate', () => { menuOpen = true; });
    ed.on('AutocompleterEnd', () => { menuOpen = false; });
    function onKey(e) {
      if (e.isComposing || e.defaultPrevented || menuOpen) return;
      const k = e.key, plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (k !== 'Delete') disarm();
      const td = cellOf(ed.selection.getNode());
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation && e.stopImmediatePropagation(); return true; };

      if (k === 'Tab' && plain && !e.shiftKey) {
        if (!td) { if (lineToTable()) return stop(); return; }
        const tr = td.parentNode, t = ownTable(td);
        if (rowsOf(t).length === 1 && tr.cells[tr.cells.length - 1] === td) {
          run(td, 'mceTableInsertColAfter', (rows, ri, ci) => cellAt(rows, ri, ci + 1));
          return stop();
        }
        return;
      }
      if (!td) return;
      const tr = td.parentNode, t = ownTable(td), rows = rowsOf(t), ri = rows.indexOf(tr);
      const lastCol = tr.cells[tr.cells.length - 1] === td;

      if (k === 'Enter' && !e.shiftKey) {
        if (e.altKey && !e.ctrlKey && !e.metaKey) { ed.execCommand('InsertLineBreak'); done(); return stop(); }
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          run(td, 'mceTableInsertRowAfter', (rows, ri) => cellAt(rows, ri + 1, 0));
          return stop();
        }
        if (!plain) return;
        // An empty last row (just added with Enter): Enter again finishes the table and carries on below it.
        if (ri === rows.length - 1 && rows.length > 1 && [...tr.cells].every(empty)) {
          ed.undoManager.transact(() => {
            tr.remove();
            let next = t.nextElementSibling;
            if (!next || next.tagName !== 'P') { next = ed.dom.create('p', {}, '<br data-mce-bogus="1">'); t.after(next); }
            place(next, false);
          });
          done(); return stop();
        }
        // Start of a row (not the first): a row above, staying where you are.
        if (td === tr.cells[0] && ri > 0 && edge(td, false)) {
          run(td, 'mceTableInsertRowBefore', (rows, ri2, ci) => cellAt(rows, ri2 + 1, ci));
          return stop();
        }
        // End of a cell in the last column: a new row below, cursor in its first cell.
        if (lastCol && edge(td, true)) {
          run(td, 'mceTableInsertRowAfter', (rows, ri2) => cellAt(rows, ri2 + 1, 0));
          return stop();
        }
        return;
      }
      if (e.ctrlKey && e.altKey && !e.metaKey && (e.code === 'KeyR' || e.code === 'KeyE')) {
        const right = e.code === 'KeyR';
        run(td, right ? 'mceTableInsertColAfter' : 'mceTableInsertColBefore', (rows, ri2, ci) => cellAt(rows, ri2, right ? ci + 1 : ci));
        return stop();
      }
      if (k === 'Delete' && plain && td === tr.cells[0] && edge(td, false) && [...tr.cells].every(empty)) {
        if (armed && armed.row === tr) {
          disarm();
          run(td, 'mceTableDeleteRow', (rows, ri2) => cellAt(rows, ri2, 0));
          return stop();
        }
        armed = { row: tr, cells: [...tr.cells] }; for (const c of armed.cells) c.setAttribute('data-mce-selected', '1');
        return stop();
      }
      if (!plain || e.shiftKey) return;
      // ---- arrows ----
      if (k === 'ArrowRight' || k === 'ArrowLeft') {
        const fwd = k === 'ArrowRight';
        if (!edge(td, fwd)) return;
        const cells = allCells(t), i = cells.indexOf(td), n = cells[i + (fwd ? 1 : -1)];
        if (!n) return; // off the end of the table: the browser moves out of it
        place(n, !fwd); return stop();
      }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        const down = k === 'ArrowDown';
        if (!onEdgeLine(td, down)) return;
        const map = grid(t), pos = posOf(map, td); if (!pos) return;
        let r = pos[0] + (down ? 1 : -1);
        while (map[r] && map[r][pos[1]] === td) r += down ? 1 : -1;
        const n = map[r] && map[r][pos[1]];
        if (!n) return; // top or bottom row: leave the table as the browser would
        const x = caretX(); if (!aim(n, x, down)) place(n, !down);
        return stop();
      }
    }
    // Caret position on screen (inside the editor frame).
    function caretRect() {
      const r = ed.selection.getRng(); let rect = r.getClientRects()[0];
      if (!rect) { const s = ed.dom.create('span', {}, '​'); r.insertNode(s); rect = s.getBoundingClientRect(); const p = s.parentNode; s.remove(); p && p.normalize(); }
      return rect;
    }
    function caretX() { const c = caretRect(); return c ? c.left : null; }
    // Is the caret on the first (up) or last (down) line of the cell?
    function onEdgeLine(td, down) {
      const c = caretRect(); if (!c) return false;
      const cs = doc().defaultView.getComputedStyle(td); const lh = parseFloat(cs.lineHeight) || 24;
      const box = td.getBoundingClientRect(), padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
      return down ? c.bottom > box.bottom - padB - lh * 0.75 : c.top < box.top + padT + lh * 0.75;
    }
    // Put the caret in `n` at the same horizontal spot, on its first line going down or last line going up.
    function aim(n, x, down) {
      if (x == null || !doc().caretRangeFromPoint) return false;
      const box = n.getBoundingClientRect(), cs = doc().defaultView.getComputedStyle(n), lh = parseFloat(cs.lineHeight) || 24;
      const y = down ? box.top + (parseFloat(cs.paddingTop) || 0) + lh / 2 : box.bottom - (parseFloat(cs.paddingBottom) || 0) - lh / 2;
      const r = doc().caretRangeFromPoint(Math.min(Math.max(x, box.left + 2), box.right - 2), y);
      if (!r || !n.contains(r.startContainer)) return false;
      ed.selection.setRng(r); ed.selection.scrollIntoView(); return true;
    }
    ed.on('keydown', onKey, true);
    ed.on('mousedown blur', disarm);
  }
  window.NCTableKeys = { attach };
})();
