from pathlib import Path
from math import ceil

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "ai-robot-concepts" / "animation-strips-v1"
FRAMES_DIR = SOURCE_DIR / "frames"
PREVIEWS_DIR = SOURCE_DIR / "previews"

FRAME_DURATION_MS = {
    "idle": 140,
    "thinking": 140,
    "talking": 90,
    "sleeping": 180,
    "searching": 110,
    "working": 100,
}


def slice_sheet(path: Path) -> list[Image.Image]:
    sheet = Image.open(path).convert("RGBA")
    cell_width = ceil(sheet.width / 4)
    cell_height = ceil(sheet.height / 2)
    frames = []
    for row in range(2):
        for column in range(4):
            left = round(column * sheet.width / 4)
            right = round((column + 1) * sheet.width / 4)
            top = round(row * sheet.height / 2)
            bottom = round((row + 1) * sheet.height / 2)
            crop = sheet.crop((left, top, right, bottom))
            frame = Image.new("RGBA", (cell_width, cell_height), (0, 0, 0, 0))
            frame.alpha_composite(
                crop,
                ((cell_width - crop.width) // 2, (cell_height - crop.height) // 2),
            )
            frames.append(frame)
    return frames


def save_preview(frames: list[Image.Image], state: str) -> None:
    duration = FRAME_DURATION_MS[state]
    webp_path = PREVIEWS_DIR / f"{state}.webp"
    frames[0].save(
        webp_path,
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=0,
        lossless=True,
        method=4,
    )

    background = (15, 23, 42, 255)
    gif_frames = []
    for frame in frames:
        composite = Image.new("RGBA", frame.size, background)
        composite.alpha_composite(frame)
        gif_frames.append(composite.convert("RGB"))
    gif_frames[0].save(
        PREVIEWS_DIR / f"{state}.gif",
        save_all=True,
        append_images=gif_frames[1:],
        duration=duration,
        loop=0,
        optimize=False,
    )


def main() -> None:
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)

    for state in FRAME_DURATION_MS:
        sheet_path = SOURCE_DIR / f"{state}.png"
        frames = slice_sheet(sheet_path)
        state_dir = FRAMES_DIR / state
        state_dir.mkdir(parents=True, exist_ok=True)
        for index, frame in enumerate(frames, start=1):
            frame.save(state_dir / f"frame-{index:02d}.png")
        save_preview(frames, state)
        print(f"{state}: {len(frames)} frames, {frames[0].size}")


if __name__ == "__main__":
    main()
