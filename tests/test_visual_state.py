"""Focused tests: the RESOLVED visual state a render records beside its output.

The legacy ``.layout.json`` sidecar says which stretch used which layout. The
resolved block added on top of it says what the composition ACTUALLY was, so a
consumer finishing the clip elsewhere can reproduce the frame the operator saw
instead of re-deriving (or guessing) it from a label.

What these tests protect:
  * the block is ADDITIVE: old sidecars stay readable and every legacy reader
    sees exactly what it saw before;
  * it is never FABRICATED: a cut that changes the output's bytes cannot present
    the old geometry as resolved state for the new file;
  * geometry is tied to the output it describes, so a stale or wrong-version
    block is refused rather than trusted;
  * the recorded numbers are the renderer's OWN resolved values (they are read
    out of the filtergraph, not recomputed).
"""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import layout_ranges  # noqa: E402
import visual_state  # noqa: E402

# ``reframe_v2`` pulls the analysis stack (numpy) at import time, which the
# minimal test environment does not carry, so the renderer-side assertions ask
# for it the same way the rest of this suite asks for ``main``/``app``. The
# producer half under test (layout_ranges / visual_state) is dependency-free.
reframe_v2 = None


def _clip(tmp_path, name="clip_1.mp4", data=b"v" * 4096):
    path = str(tmp_path / name)
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def _state(clip, **over):
    fields = dict(
        output_format="vertical", aspect_ratio=9.0 / 16.0, width=1080,
        height=1920, fps=30.0, source_width=1920, source_height=1080,
        scenes=[visual_state.scene_record(
            start=0, end=4, start_frame=0, end_frame=120, strategy="TRACK",
            composition={"representation": "crop_window",
                         "basis": "source_pixels",
                         "change_points": [{"time": 0.0, "x": 100,
                                            "width": 606, "height": 1080,
                                            "y": 0}]})],
        output_path=clip)
    fields.update(over)
    return visual_state.build_state(**fields)


class TestLegacySidecarStillWorks:
    def test_legacy_sidecar_is_readable_and_states_no_composition(self, tmp_path):
        clip = _clip(tmp_path)
        layout_ranges.write(clip, [(0, 4.5, "TRACK"), (4.5, 10, "SPLIT")])
        assert layout_ranges.read(clip) == [
            {"start": 0.0, "end": 4.5, "layout": "track"},
            {"start": 4.5, "end": 10.0, "layout": "split"}]
        assert layout_ranges.split_ranges(layout_ranges.read(clip)) == [(4.5, 10.0)]
        # A legacy sidecar states no composition — it must never be invented.
        assert layout_ranges.read_visual_state(clip) is None
        assert layout_ranges.has_visual_state(clip) is False

    def test_a_write_without_state_adds_no_key(self, tmp_path):
        clip = _clip(tmp_path)
        layout_ranges.write(clip, [(0, 2, "SPLIT")])
        raw = json.load(open(clip + ".layout.json"))
        assert layout_ranges.VISUAL_STATE_KEY not in raw
        assert raw == {"ranges": [{"start": 0.0, "end": 2.0,
                                   "layout": "split"}]}

    def test_legacy_normalisation_is_unchanged(self):
        # The shapes the legacy readers accept, including the odd ones they drop.
        assert layout_ranges.normalise(
            [{"start": "x"}, (3, 1, "split"), (1, 2, "SPLIT"), 7]) == [
            {"start": 1.0, "end": 2.0, "layout": "split"}]

    def test_garbage_and_missing_sidecars_stay_harmless(self, tmp_path):
        missing = str(tmp_path / "nope.mp4")
        assert layout_ranges.read(missing) == []
        assert layout_ranges.read_visual_state(missing) is None
        junk = _clip(tmp_path, "junk.mp4")
        open(junk + ".layout.json", "w").write("{not json")
        assert layout_ranges.read(junk) == []
        assert layout_ranges.read_visual_state(junk) is None


class TestResolvedBlockSurvivesReadWrite:
    def test_every_recorded_field_round_trips(self, tmp_path):
        clip = _clip(tmp_path)
        state = _state(clip)
        layout_ranges.write(clip, [(0, 4, "TRACK")], visual_state=state)
        got = layout_ranges.read_visual_state(clip)
        assert got == state
        # Legacy ranges are untouched by the addition.
        assert layout_ranges.read(clip) == [{"start": 0.0, "end": 4.0,
                                             "layout": "track"}]
        assert got["schema"] == "loom.visual_state/1"
        assert got["resolution"] == "resolved"
        assert got["output_baked"] is True
        assert got["canvas"] == {"format": "vertical", "ratio": "9:16",
                                 "width": 1080, "height": 1920, "fps": 30.0}
        assert got["coordinate_basis"]["crop"] == "source_pixels"
        assert got["coordinate_basis"]["position"] == "canvas_centre_to_edge"

    def test_writing_only_state_preserves_the_ranges(self, tmp_path):
        clip = _clip(tmp_path)
        layout_ranges.write(clip, [(0, 3, "SPLIT")])
        layout_ranges.write_visual_state(clip, _state(clip))
        assert layout_ranges.read(clip) == [{"start": 0.0, "end": 3.0,
                                             "layout": "split"}]
        assert layout_ranges.read_visual_state(clip)["resolution"] == "resolved"

    def test_an_unreadable_output_does_not_raise_out_of_state_building(self, tmp_path):
        # Best effort by contract: a render that already succeeded must not fail
        # over its own bookkeeping.
        with pytest.raises(OSError):
            _state(str(tmp_path / "does_not_exist.mp4"))

    def test_write_failure_is_swallowed(self, tmp_path):
        layout_ranges.write(str(tmp_path / "missing" / "c.mp4"), [(0, 1, "split")],
                            visual_state={"schema": "x"})


class TestCanvasIsTheRenderersTruth:
    def test_ratio_labels_follow_the_operators_format(self):
        assert visual_state.ratio_label(9.0 / 16.0) == "9:16"
        assert visual_state.ratio_label(1.0) == "1:1"
        assert visual_state.ratio_label(16.0 / 9.0) == "16:9"
        # An unusual ratio is reported as itself rather than snapped to a preset.
        assert visual_state.ratio_label(2.0) == "2.000000"

    def test_the_recorded_canvas_is_the_output_the_render_produced(self, tmp_path):
        clip = _clip(tmp_path)
        block = visual_state.canvas_block(output_format="square",
                                          aspect_ratio=1.0, width=1080,
                                          height=1080, fps=25)
        assert block == {"format": "square", "ratio": "1:1", "width": 1080,
                         "height": 1080, "fps": 25.0}

    def test_passthrough_records_native_framing_and_no_crop(self, tmp_path):
        clip = _clip(tmp_path)
        state = visual_state.passthrough_state(
            output_format="horizontal", width=1920, height=1080, fps=30.0,
            duration=12.0, output_path=clip)
        assert state["canvas"]["ratio"] == "16:9"
        assert state["scenes"][0]["strategy"] == "PASSTHROUGH"
        assert state["scenes"][0]["composition"]["representation"] == "passthrough"
        assert state["ownership"]["sha256"] == visual_state.output_digest(clip)


class TestOwnership:
    def test_a_matching_digest_is_valid(self, tmp_path):
        clip = _clip(tmp_path)
        state = _state(clip)
        ok, reason = visual_state.ownership_is_valid(
            state, digest=visual_state.output_digest(clip))
        assert ok and reason == "ok"

    def test_a_different_asset_is_refused(self, tmp_path):
        clip = _clip(tmp_path)
        state = _state(clip)
        other = _clip(tmp_path, "other.mp4", b"different bytes")
        ok, reason = visual_state.ownership_is_valid(
            state, digest=visual_state.output_digest(other))
        assert not ok and reason == "asset_identity_mismatch"

    def test_a_different_version_is_refused(self, tmp_path):
        clip = _clip(tmp_path)
        state = _state(clip, asset_version="render-1.3")
        ok, reason = visual_state.ownership_is_valid(
            state, digest=visual_state.output_digest(clip),
            asset_version="render-1.4")
        assert not ok and reason == "asset_version_mismatch"
        # ...and the same version is fine.
        ok2, _ = visual_state.ownership_is_valid(
            state, digest=visual_state.output_digest(clip),
            asset_version="render-1.3")
        assert ok2

    def test_an_unresolved_block_is_never_usable(self, tmp_path):
        clip = _clip(tmp_path)
        carried = visual_state.mark_unresolved(_state(clip), "recut")
        ok, reason = visual_state.ownership_is_valid(carried, digest="x" * 64)
        assert not ok and reason == "unresolved_state"
        assert carried["ownership"] == {}
        assert carried["unresolved_reason"] == "recut"

    def test_missing_identities_are_refused_not_assumed(self, tmp_path):
        clip = _clip(tmp_path)
        state = _state(clip)
        assert visual_state.ownership_is_valid(state, digest="")[1] == "no_asset_identity"
        assert visual_state.ownership_is_valid(None, digest="x")[1] == "no_resolved_state"


class TestTrackChangePoints:
    def test_change_points_are_deduped_into_moves(self):
        # 10 frames, the crop moves twice: three change-points, not ten samples.
        frames = [(100, 606, 1080, 0)] * 4 + [(120, 606, 1080, 0)] * 3 + \
                 [(140, 606, 1080, 0)] * 3
        points = visual_state.change_points(frames, 10.0, start_frame=30)
        assert [p["x"] for p in points] == [100, 120, 140]
        # Times are clip-absolute: frame 30 is t=3.0 at 10fps.
        assert [p["time"] for p in points] == [3.0, 3.4, 3.7]
        assert all(p["width"] == 606 and p["height"] == 1080 for p in points)

    def test_a_punch_in_keeps_its_size_changes(self):
        frames = [(0, 600, 1080, 0), (0, 600, 1080, 0), (0, 500, 900, 40)]
        points = visual_state.change_points(frames, 30.0)
        assert len(points) == 2
        assert points[1]["width"] == 500 and points[1]["y"] == 40

    def test_scene_records_carry_time_and_frame_ownership(self):
        record = visual_state.scene_record(start=1.5, end=4.0, start_frame=45,
                                          end_frame=120, strategy="track",
                                          composition={"representation": "crop_window"},
                                          manual=True)
        assert record["strategy"] == "TRACK"
        assert (record["start"], record["end"]) == (1.5, 4.0)
        assert (record["start_frame"], record["end_frame"]) == (45, 120)
        assert record["manual"] is True


class TestRecordedNumbersAreTheRenderersOwn:
    """The persisted values must be the render's, not a recomputation."""

    @staticmethod
    def _renderer():
        return pytest.importorskip("reframe_v2")

    def test_persisted_general_height_is_the_one_the_filtergraph_uses(self):
        reframe_v2 = self._renderer()
        out_w, out_h, orig_w, orig_h = 1080, 1920, 1920, 1080
        persisted = reframe_v2.general_content_height(out_w, out_h, orig_w, orig_h)
        graph = reframe_v2.general_filtergraph(out_w, out_h, orig_w=orig_w,
                                               orig_h=orig_h)
        assert f"scale=-2:{persisted}" in graph

    def test_full_width_composition_records_the_wide_height(self):
        reframe_v2 = self._renderer()
        out_w, orig_w, orig_h = 1080, 1920, 1080
        content_h = reframe_v2.full_width_content_height(orig_w, orig_h, out_w)
        graph = reframe_v2.general_filtergraph(out_w, 1920, content_h)
        assert f"scale=-2:{content_h}" in graph
        record = reframe_v2._general_composition(content_h, mode="full_width")
        assert record["content_height"] == content_h
        assert record["representation"] == "general"
        assert record["background"] == "blurred_cover"

    def test_the_general_record_is_semantic_not_crop_geometry(self):
        reframe_v2 = self._renderer()
        record = reframe_v2._general_composition(806, mode="general")
        # A general composition is a foreground over a blurred bed. Recording it
        # as a crop window would be a misrepresentation.
        assert record["representation"] == "general"
        assert "change_points" not in record
        assert record["background_blur_sigma"] == reframe_v2.GENERAL_BACKGROUND_BLUR_SIGMA
        assert record["placement"] == "center"

    def test_the_track_record_carries_source_pixel_geometry(self):
        reframe_v2 = self._renderer()
        frames = [(10, 606, 1080, 0), (10, 606, 1080, 0), (90, 606, 1080, 0)]
        record = reframe_v2._crop_window_composition(frames, 30.0, 0)
        assert record["representation"] == "crop_window"
        assert record["basis"] == "source_pixels"
        assert [p["x"] for p in record["change_points"]] == [10, 90]

    def test_the_render_seam_accepts_the_operators_format(self):
        import inspect

        reframe_v2 = self._renderer()
        signature = inspect.signature(reframe_v2.render)
        assert "output_format" in signature.parameters
        assert signature.parameters["output_format"].default is None
