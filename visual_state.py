"""Resolved visual state for a rendered clip — the PRODUCER half.

The legacy ``.layout.json`` sidecar records only which stretch of a clip used
which layout (a coarse label, enough for caption placement). A consumer that
finishes the clip elsewhere needs the ACTUAL composition the render used: the
canvas the operator picked, and per scene the resolved crop window / general
composition. Re-deriving that from the label is impossible — "track" does not
say where the window sat — and guessing it is how an edit reverted to raw
source framing.

So this module builds an ADDITIVE top-level block that travels in the same
sidecar and is written by the render itself, at the one seam where the numbers
are already resolved (``reframe_v2.render``). It never recomputes a layout: it
records what the renderer already decided.

Two hard rules, both about honesty:

* **Ownership.** The block is tied to the output it describes (filename +
  sha256) and, when known, the LOOM asset version. Another asset or version
  must not consume stale geometry, so a consumer verifies ownership before it
  trusts the numbers.
* **Never fabricate.** A block is either ``resolved`` (produced by a render) or
  ``unresolved`` (carried across a cut that changed the output identity, with
  the reason recorded). A legacy layout label is never promoted into geometry.

Coordinate basis is explicit because the numbers are useless without it:
crop geometry is SOURCE pixels, the canvas is OUTPUT pixels, and a hand
override originates as a SOURCE-WIDTH FRACTION (see
``reframe_v2.apply_crop_overrides``).

The consumer half lives on the CapCut side (``infra/discord-review/
visual_state.py``); the JSON block is the contract between them.
"""
import hashlib
import os

SCHEMA = "loom.visual_state/1"

RESOLVED = "resolved"
UNRESOLVED = "unresolved"

#: Operator output formats -> the aspect ratio the render used for each.
#: "auto" is the pipeline's own default and renders vertical (see
#: ``main.render_clip``), so it is recorded as vertical when a renderer reports
#: it rather than being treated as a separate format.
OUTPUT_FORMAT_ASPECT = {"vertical": 9.0 / 16.0, "square": 1.0,
                        "horizontal": 16.0 / 9.0}

COORDINATE_BASIS = {
    "canvas": "output_pixels",
    "crop": "source_pixels",
    "crop_override": "source_width_fraction",
    # CapCut's own normalized transform space: 0 is the canvas centre and 1 is
    # the edge the position is measured toward (the donor documents --x/--y as
    # "-1 to 1" and lints |y|>0.85 as the platform UI band on a vertical
    # canvas). Recorded here because a consumer must not have to guess the
    # basis its numbers are expressed in.
    "position": "canvas_centre_to_edge",
}


def ratio_label(aspect_ratio):
    """``9:16`` / ``1:1`` / ``16:9`` for a numeric aspect, else the number.

    Labels only: the persisted width/height pair is the truth a consumer uses,
    so an unusual ratio is reported as itself rather than snapped to a preset.
    """
    try:
        ratio = float(aspect_ratio)
    except (TypeError, ValueError):
        return ""
    for label, value in (("9:16", 9.0 / 16.0), ("1:1", 1.0), ("16:9", 16.0 / 9.0)):
        if abs(ratio - value) < 1e-6:
            return label
    return f"{ratio:.6f}"


def canvas_block(*, output_format, aspect_ratio, width, height, fps=None):
    """The ACTUAL canvas a render produced — never a default."""
    return {
        "format": str(output_format or "").lower(),
        "ratio": ratio_label(aspect_ratio),
        "width": int(width),
        "height": int(height),
        "fps": float(fps) if fps else None,
    }


def change_points(frames, fps, *, start_frame=0):
    """Deduped per-frame geometry -> change-points in CLIP seconds.

    ``frames`` is a list of ``(x, w, h[, y])`` in SOURCE pixels, one per decoded
    frame of the scene. Only the frames where the tuple actually changes are
    kept: a 30s crop-follow at 30fps is ~900 samples of which maybe 40 are real
    moves, and persisting every frame would be a transcript, not state.

    Times are clip-absolute (``(start_frame + i) / fps``), matching the scene
    ranges, so a consumer needs no other clock.
    """
    out = []
    prev = None
    for i, frame in enumerate(frames or []):
        geom = tuple(int(round(float(v))) for v in frame)
        if geom == prev:
            continue
        point = {"time": round((start_frame + i) / float(fps), 4),
                 "x": geom[0], "width": geom[1], "height": geom[2]}
        if len(geom) > 3:
            point["y"] = geom[3]
        out.append(point)
        prev = geom
    return out


def scene_record(*, start, end, start_frame, end_frame, strategy,
                 composition=None, manual=False):
    """One scene's resolved composition, tagged with the strategy that owns it."""
    record = {
        "start": round(float(start), 4),
        "end": round(float(end), 4),
        "start_frame": int(start_frame),
        "end_frame": int(end_frame),
        "strategy": str(strategy or "").upper(),
        "manual": bool(manual),
    }
    if composition:
        record["composition"] = composition
    return record


def output_digest(path):
    """sha256 of a file's bytes — the identity a resolved block is tied to."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_state(*, output_format, aspect_ratio, width, height, fps, source_width,
                source_height, scenes, output_path, asset_version=""):
    """The resolved block for one render, ready to persist beside its output.

    Raises ``OSError`` when the output cannot be read for its digest — the
    caller treats sidecar persistence as best effort (a render that already
    succeeded must never fail over its own bookkeeping).
    """
    return {
        "schema": SCHEMA,
        "resolution": RESOLVED,
        # The composition is IN the output's own pixels: the render cropped,
        # scaled and concatenated it. A consumer must not apply the recorded
        # geometry a second time — it is recorded so the composition can be
        # interpreted and verified, and so an UN-composed asset can be composed
        # to match.
        "output_baked": True,
        "ownership": {
            "output_filename": os.path.basename(str(output_path or "")),
            "sha256": output_digest(output_path),
            "asset_version": str(asset_version or ""),
        },
        "canvas": canvas_block(output_format=output_format,
                               aspect_ratio=aspect_ratio, width=width,
                               height=height, fps=fps),
        "coordinate_basis": dict(COORDINATE_BASIS),
        "source": {"width": int(source_width), "height": int(source_height)},
        "scenes": list(scenes or []),
    }


def mark_unresolved(state, reason, *, derived_from=None):
    """A carried-forward block whose output identity no longer holds.

    Used by a cut that changes the bytes on disk (the recut fast path): the
    geometry may still describe the SOURCE crop, but it no longer owns the file
    it would sit beside, so it must not present itself as resolved. The reason
    is recorded verbatim and the ownership is cleared — a consumer then knows to
    obtain authoritative state instead of trusting these numbers.
    """
    carried = dict(state or {})
    carried["resolution"] = UNRESOLVED
    carried["unresolved_reason"] = str(reason)
    carried["ownership"] = {}
    if derived_from:
        carried["derived_from"] = {
            "output_filename": derived_from.get("output_filename", ""),
            "sha256": derived_from.get("sha256", ""),
            "asset_version": derived_from.get("asset_version", ""),
        }
    return carried


def passthrough_state(*, output_format, width, height, fps, duration,
                      output_path, asset_version=""):
    """Resolved state for an output that kept its NATIVE framing.

    A horizontal (or already-fitting) export is a remux, not a reframe: there
    is no crop window and nothing was rearranged. Recording that explicitly is
    what keeps a consumer from having to assume a canvas for a real operator
    choice — the composition is the identity, and it says so.
    """
    frames = int(round(float(fps) * float(duration))) if fps and duration else 0
    return {
        "schema": SCHEMA,
        "resolution": RESOLVED,
        # Native framing: nothing was rearranged, and the output's pixels say so.
        "output_baked": True,
        "ownership": {
            "output_filename": os.path.basename(str(output_path or "")),
            "sha256": output_digest(output_path),
            "asset_version": str(asset_version or ""),
        },
        "canvas": canvas_block(output_format=output_format,
                               aspect_ratio=float(width) / float(height),
                               width=width, height=height, fps=fps),
        "coordinate_basis": dict(COORDINATE_BASIS),
        "source": {"width": int(width), "height": int(height)},
        "scenes": [scene_record(
            start=0.0, end=float(duration or 0.0), start_frame=0,
            end_frame=frames, strategy="PASSTHROUGH",
            composition={"representation": "passthrough",
                         "basis": "output_pixels"})],
    }


def is_resolved(state):
    return (isinstance(state, dict) and state.get("schema") == SCHEMA
            and state.get("resolution") == RESOLVED)


def _geometry_at(points, when):
    """The geometry in force at clip time ``when`` (last change-point at/before it)."""
    held = None
    for point in points:
        try:
            t = float(point.get("time"))
        except (TypeError, ValueError):
            continue
        if t <= when + 1e-9:
            held = point
        else:
            break
    return held if held is not None else (points[0] if points else None)


def _shift_composition(composition, *, seg_start, offset, window_start,
                       window_end, fps):
    """Move a scene's composition onto the recut timeline, keeping its values.

    Only TIME moves: the crop geometry is in SOURCE pixels, which a cut-and-
    concat does not touch. A window truncated by a segment boundary keeps the
    geometry that was actually in force at the new start, so the first frame of
    the carried scene is the real one rather than a guess.
    """
    if not isinstance(composition, dict):
        return composition
    moved = dict(composition)
    points = composition.get("change_points")
    if not isinstance(points, list) or not points:
        return moved
    usable = [p for p in points if isinstance(p, dict)]

    def out_time(t):
        return round(t - seg_start + offset, 4)

    kept = []
    start_geometry = _geometry_at(usable, window_start - offset + seg_start)
    if start_geometry is not None:
        lead = dict(start_geometry)
        lead["time"] = out_time(window_start - offset + seg_start)
        kept.append(lead)
    for point in usable:
        try:
            t = float(point["time"])
        except (KeyError, TypeError, ValueError):
            continue
        when = t - seg_start + offset
        if when <= window_start + 1e-9 or when > window_end + 1e-9:
            continue
        if kept and kept[-1].get("x") == point.get("x") \
                and kept[-1].get("width") == point.get("width") \
                and kept[-1].get("height") == point.get("height"):
            continue
        entry = dict(point)
        entry["time"] = round(when, 4)
        kept.append(entry)
    moved["change_points"] = kept
    return moved


def remap_state(state, segments, *, reason="recut_changed_output_identity"):
    """Carry a resolved block across a cut-and-concat, and say it is unresolved.

    The block describes the bytes of the file it was written beside. A recut
    writes DIFFERENT bytes, so the carried geometry no longer owns the output
    and must not present itself as resolved — this remaps it for reference and
    marks it honestly, which is what lets a consumer decide to obtain
    authoritative state instead of trusting stale numbers.

    Returns None when there is nothing to carry. It never PROMOTES anything:
    an absent block stays absent, and a legacy layout range is never turned
    into geometry.
    """
    if not isinstance(state, dict) or not state.get("scenes"):
        return None
    try:
        fps = float((state.get("canvas") or {}).get("fps") or 0.0)
    except (TypeError, ValueError):
        fps = 0.0

    scenes = []
    offset = 0.0
    for seg in segments or []:
        try:
            seg_start, seg_end = float(seg["start"]), float(seg["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if seg_end <= seg_start:
            continue
        for scene in state.get("scenes") or []:
            if not isinstance(scene, dict):
                continue
            try:
                s, e = float(scene.get("start")), float(scene.get("end"))
            except (TypeError, ValueError):
                continue
            lo, hi = max(s, seg_start), min(e, seg_end)
            if hi - lo <= 1e-9:
                continue
            window_start = round(lo - seg_start + offset, 4)
            window_end = round(hi - seg_start + offset, 4)
            moved = dict(scene)
            moved["start"] = window_start
            moved["end"] = window_end
            if fps > 0:
                moved["start_frame"] = int(round(window_start * fps))
                moved["end_frame"] = int(round(window_end * fps))
            moved["composition"] = _shift_composition(
                scene.get("composition"), seg_start=seg_start, offset=offset,
                window_start=window_start, window_end=window_end, fps=fps)
            scenes.append(moved)
        offset += seg_end - seg_start

    if not scenes:
        return None
    carried = mark_unresolved(state, reason,
                             derived_from=state.get("ownership") or {})
    carried["scenes"] = scenes
    return carried


def ownership_is_valid(state, *, digest="", asset_version=""):
    """(valid, reason) — whether this block describes the asset it would be used for.

    Both signals must agree with the block's own record:
      * the bytes: the digest of the asset being consumed must equal the digest
        the render recorded (a re-render, a re-cut or any other rewrite changes
        it, and then the geometry describes a file that no longer exists);
      * the version, when BOTH sides state one — a mismatch means a different
        version of the same clip, which is exactly the stale-geometry failure
        this guards.
    """
    if not is_resolved(state):
        reason = "unresolved_state" if isinstance(state, dict) and state.get("schema") == SCHEMA \
            else "no_resolved_state"
        return False, reason
    own = state.get("ownership") or {}
    recorded = str(own.get("sha256") or "")
    if not recorded:
        return False, "no_recorded_identity"
    if not digest:
        return False, "no_asset_identity"
    if str(digest) != recorded:
        return False, "asset_identity_mismatch"
    recorded_version = str(own.get("asset_version") or "")
    current = str(asset_version or "")
    if recorded_version and current and recorded_version != current:
        return False, "asset_version_mismatch"
    return True, "ok"
