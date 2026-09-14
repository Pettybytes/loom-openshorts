// captionRealign.js — deterministic caption timing redistribution.
//
// Compares the original timestamped caption words with an edited caption and
// redistributes timings so that:
//   * unchanged words preserve their original timestamps;
//   * same-position replacements inherit the replaced word's timing;
//   * deleted words (and their timings) are removed;
//   * inserted words receive timings interpolated between the nearest unchanged
//     timestamped anchors (proportionally, monotonically);
//   * leading insertions use [clipStart, first anchor]; trailing insertions use
//     [last anchor, clipEnd].
//
// Fails safely: a major rewrite with insufficient anchors is marked
// `realignment_required` and returns NO blocks (the caller must not rerender
// with misleading timings, and must not auto-invoke a paid model).

export function tokenize(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

// Normalize a word for comparison: lowercase + strip punctuation/formatting, so
// capitalization/punctuation-only edits do not disturb timing.
export function normalizeWord(word) {
  return String(word).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Min edit distance with match (0) / replace (1) / insert (1) / delete (1),
// backtracked deterministically (prefer match, then replace, then insert, then
// delete). Returns ops in forward order: {type, oi?, ei?}.
function diffSequence(origNorm, editNorm) {
  const n = origNorm.length, m = editNorm.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i;
  for (let j = 1; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (origNorm[i - 1] === editNorm[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j - 1] + 1, dp[i][j - 1] + 1, dp[i - 1][j] + 1);
      }
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origNorm[i - 1] === editNorm[j - 1]) {
      ops.push({ type: 'match', oi: i - 1, ei: j - 1 }); i--; j--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      ops.push({ type: 'insert', ei: j - 1 }); j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'delete', oi: i - 1 }); i--;
    } else {
      // replace is the last resort: only when it is the unique minimum.
      ops.push({ type: 'replace', oi: i - 1, ei: j - 1 }); i--; j--;
    }
  }
  ops.reverse();
  return ops;
}

function clampDuration(blocks, minDurationMs) {
  // Enforce a minimum display duration by expanding short blocks forward without
  // overlapping the next block's start. Best-effort; returns false if it cannot.
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.endMs - b.startMs >= minDurationMs) continue;
    const nextStart = k + 1 < blocks.length ? blocks[k + 1].startMs : b.endMs + minDurationMs;
    const room = nextStart - b.startMs;
    if (room < minDurationMs) return false;
    b.endMs = b.startMs + minDurationMs;
  }
  return true;
}

/**
 * @param {Array<{text:string,startMs:number,endMs:number}>} originalWords
 * @param {string} editedText
 * @param {{trimStartMs?:number, trimEndMs?:number, minDurationMs?:number}} [opts]
 * @returns {{alignment:'preserved'|'redistributed'|'realignment_required',
 *            changedCount:number, confidence:number,
 *            blocks:Array<{text:string,startMs:number,endMs:number}>}}
 */
export function realignCaptions(originalWords, editedText, opts = {}) {
  const {
    trimStartMs = 0,
    trimEndMs = Math.max(...originalWords.map(w => w.endMs ?? 0), 0),
    minDurationMs = 200,
  } = opts;

  const editTokens = tokenize(editedText);
  const origNorm = originalWords.map(w => normalizeWord(w.text));
  const editNorm = editTokens.map(normalizeWord);

  const ops = diffSequence(origNorm, editNorm);

  let matched = 0, replaced = 0, inserted = 0, deleted = 0;
  for (const op of ops) {
    if (op.type === 'match') matched++;
    else if (op.type === 'replace') replaced++;
    else if (op.type === 'insert') inserted++;
    else if (op.type === 'delete') deleted++;
  }
  const changedCount = replaced + inserted + deleted;
  const total = Math.max(origNorm.length, editNorm.length, 1);
  const changedRatio = changedCount / total;

  // Fail-safe classification.
  const anchors = matched;
  let alignment;
  if (editNorm.length === 0) {
    alignment = 'realignment_required'; // empty caption
  } else if (anchors === 0 && editNorm.length > 1) {
    alignment = 'realignment_required'; // multi-word edit with no unchanged anchor
  } else if (changedRatio > 0.7) {
    alignment = 'realignment_required'; // major rewrite
  } else if (changedCount === 0) {
    alignment = 'preserved';
  } else {
    alignment = 'redistributed';
  }

  const confidence = anchors / Math.max(1, editNorm.length);

  // UNCHANGED caption = preserved, always. Trimming is a separate operation
  // (segments), not a rewrite of spoken text. Return the original word blocks
  // verbatim and skip interpolation + range validation, so a trim-only edit can
  // never surface as "realignment required" nor contradict its 0-change count.
  if (changedCount === 0) {
    const preservedBlocks = originalWords.map((w) => ({
      text: String(w?.text ?? '').trim(),
      startMs: Number(w?.startMs ?? 0),
      endMs: Number(w?.endMs ?? 0),
    }));
    return { alignment: 'preserved', changedCount: 0, confidence, blocks: preservedBlocks };
  }

  if (alignment === 'realignment_required') {
    return { alignment, changedCount, confidence, blocks: [] };
  }

  // Known timings for match/replace (inherit original timing).
  const known = new Map();
  for (const op of ops) {
    if (op.type === 'match' || op.type === 'replace') {
      const ow = originalWords[op.oi];
      known.set(op.ei, { startMs: ow.startMs, endMs: ow.endMs });
    }
  }

  // Build blocks in edited order; interpolate runs of inserted words.
  const blocks = [];
  const anchorsSorted = [...known.entries()].map(([ei, t]) => ({ ei, ...t })).sort((a, b) => a.ei - b.ei);
  let idx = 0;
  while (idx < editTokens.length) {
    const k = known.get(idx);
    if (k) {
      blocks.push({ text: editTokens[idx], startMs: k.startMs, endMs: k.endMs });
      idx++;
    } else {
      let runEnd = idx;
      while (runEnd < editTokens.length && !known.has(runEnd)) runEnd++;
      const runCount = runEnd - idx;
      const prev = anchorsSorted.filter(a => a.ei < idx).pop();
      const next = anchorsSorted.find(a => a.ei >= runEnd);
      const start = prev ? prev.endMs : trimStartMs;
      const end = next ? next.startMs : trimEndMs;
      const span = Math.max(0, end - start);
      // Enforce the minimum display duration on inserted words only. If the
      // available interval is too tight, fail safe — never fabricate timing.
      if (span < minDurationMs * runCount) {
        return { alignment: 'realignment_required', changedCount, confidence, blocks: [] };
      }
      const per = span / runCount;
      for (let kk = 0; kk < runCount; kk++) {
        blocks.push({
          text: editTokens[idx + kk],
          startMs: Math.round(start + kk * per),
          endMs: Math.round(start + (kk + 1) * per),
        });
      }
      idx = runEnd;
    }
  }

  // Sort by start (they are already ordered), then validate monotonic +
  // non-overlapping + within range. (Minimum display duration is enforced
  // during interpolation above, not on preserved original timings.)
  blocks.sort((a, b) => a.startMs - b.startMs);
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.startMs < trimStartMs || b.endMs > trimEndMs) {
      return { alignment: 'realignment_required', changedCount, confidence, blocks: [] };
    }
    if (k > 0 && b.startMs < blocks[k - 1].endMs) {
      return { alignment: 'realignment_required', changedCount, confidence, blocks: [] };
    }
  }

  return { alignment, changedCount, confidence, blocks };
}

export default realignCaptions;
