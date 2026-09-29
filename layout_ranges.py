"""Which stretches of a rendered clip use which layout, kept next to the clip.

reframe_v2 decides a layout per scene (TRACK, GENERAL, SPLIT, ...) and renders
it, and nothing downstream used to know. Captions need to: on a SPLIT scene
the two speakers sit one above the other and the seam between the halves is
the emptiest place in the frame, so that is where the captions go (OpusClip
does the same). On every other layout they stay at the bottom.

The ranges travel as a sidecar ``<clip>.layout.json`` written by the render,
because the render happens in four different places (the job pipeline, the
recut/rerender, the manual reframe and the v1 fallback, which writes none)
and a return value would have to be threaded through all of them. Times are
in the CLIP's own timeline, which is also the timeline captions are laid on.
Whoever updates a clip's metadata copies them into ``layout_ranges`` so
/api/subtitle can find them after the sidecar is gone.
"""
import json
import os

SIDECAR_SUFFIX = ".layout.json"

#: Top-level sidecar key holding the RESOLVED composition (see
#: ``visual_state``). Additive and separate from ``ranges`` on purpose: the
#: legacy range objects have a fixed ``{start,end,layout}`` shape, so geometry
#: stuffed into them would be dropped by ``normalise()`` and would change what
#: every existing reader sees.
VISUAL_STATE_KEY = "visual_state"


def sidecar_path(video_path):
    return video_path + SIDECAR_SUFFIX


def _read_payload(video_path):
    """The sidecar's raw object, or {} (absent, v1 render, hand-edited junk)."""
    try:
        with open(sidecar_path(video_path)) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write(video_path, ranges, visual_state=None):
    """``ranges``: iterable of (start_s, end_s, strategy). Best effort: a
    failure here must never fail a render that already succeeded.

    ``visual_state`` is the additive resolved block (see ``visual_state``);
    omitting it leaves the legacy sidecar exactly as it was, so every existing
    caller keeps writing the same file it always did.
    """
    payload = [{"start": round(float(s), 3), "end": round(float(e), 3),
                "layout": str(layout).lower()} for s, e, layout in ranges]
    body = {"ranges": payload}
    if visual_state:
        body[VISUAL_STATE_KEY] = visual_state
    try:
        with open(sidecar_path(video_path), "w") as f:
            json.dump(body, f)
    except OSError:
        pass
    return payload


def read(video_path):
    """The ranges recorded for this file, or [] (no sidecar, v1 render, or
    a file that was never reframed)."""
    return normalise(_read_payload(video_path).get("ranges"))


def read_visual_state(video_path):
    """The RESOLVED composition block for this file, or None.

    None means "the render did not record one" — an old sidecar, a v1 render, a
    file that was never reframed, or a block whose shape is not one we wrote.
    This function never synthesises a block from the legacy layout ranges: a
    label is not geometry (see ``visual_state``).
    """
    state = _read_payload(video_path).get(VISUAL_STATE_KEY)
    return state if isinstance(state, dict) else None


def write_visual_state(video_path, state, ranges=None):
    """Replace only the resolved block, keeping whatever ranges are recorded.

    ``ranges=None`` reads the existing ranges back out of the sidecar so a
    caller that owns only the composition does not have to restate them (and
    cannot accidentally erase them).
    """
    if ranges is None:
        ranges = read(video_path)
    return write(video_path, [(r["start"], r["end"], r["layout"])
                              for r in normalise(ranges)], visual_state=state)


def has_visual_state(video_path):
    return read_visual_state(video_path) is not None


def normalise(ranges):
    """Accept the sidecar/metadata shape or bare tuples; drop anything odd
    (an old metadata file, a hand-edited value) instead of raising."""
    out = []
    for r in ranges or []:
        try:
            if isinstance(r, dict):
                s, e, layout = r["start"], r["end"], r.get("layout", "")
            else:
                s, e, layout = r
            s, e = float(s), float(e)
        except (KeyError, TypeError, ValueError):
            continue
        if e > s:
            out.append({"start": s, "end": e, "layout": str(layout).lower()})
    return out


def split_ranges(ranges):
    """(start, end) pairs of the stretches where captions belong on the seam."""
    return [(r["start"], r["end"]) for r in normalise(ranges) if r["layout"] == "split"]


def in_split(t, splits):
    return any(s <= t < e for s, e in splits or [])


def remap(ranges, segments):
    """Carry ranges across a cut-and-concat. ``segments`` are the kept
    stretches of the SOURCE file in order ({"start", "end"}); the output is
    those segments back to back, so each range is clipped to every segment it
    overlaps and shifted to where that segment landed. This is what the fast
    rerender needs: it never reframes, so the only layout information it can
    have is the canonical clip's, seen through the new cut."""
    out = []
    offset = 0.0
    for seg in segments or []:
        try:
            seg_s, seg_e = float(seg["start"]), float(seg["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if seg_e <= seg_s:
            continue
        for r in normalise(ranges):
            s, e = max(r["start"], seg_s), min(r["end"], seg_e)
            if e > s:
                out.append({"start": round(s - seg_s + offset, 3),
                            "end": round(e - seg_s + offset, 3),
                            "layout": r["layout"]})
        offset += seg_e - seg_s
    return out
