"""Prompt contracts for still images, grounded in MiniMax's H3 Image guides."""

IMAGE_CREATE = "ImageCreate"
IMAGE_EDIT = "ImageEdit"
IMAGE_MODES = frozenset({IMAGE_CREATE, IMAGE_EDIT})
IMAGE_REFERENCE_LIMIT = 16

_COMMON = (
    "Write a prompt for one finished still image in MiniMax H3 Image. Respect the requested composition, medium, "
    "exact counts, colors, spatial relationships and exclusions. Describe visible details that serve the brief, "
    "such as framing, lighting or materials. Keep explicitly supplied on-image wording verbatim, in its original "
    "language, and describe its placement. Use the canvas width-to-height ratio to guide layout. Omit the numeric "
    "canvas ratio and render settings from the caption unless requested. Return only the image prompt in plain "
    "text. Leave out headings, Markdown, timecodes, shot sequences and audio directions. "
)

IMAGE_SYSTEM_PROMPTS = {
    IMAGE_CREATE: _COMMON + (
        "Describe the intended scene or designed artifact directly. Build only the details needed by the brief. "
        "If the brief excludes on-image text, state that the finished image contains no lettering. There are no "
        "reference pictures for this task."
    ),
    IMAGE_EDIT: _COMMON + (
        "Write one continuous paragraph describing the desired result. Use <Picture 1> for the base and subsequent "
        "<Picture N> numbers for donors in supplied order. For any retained or transferred content that needs an "
        "explicit identity, bind the visible source to a stable <Subject N> before describing its role in the result. "
        "Name what changes, where, and which identity, composition, wording or other traits stay. Borrow only the "
        "assigned properties from a donor. Use only the listed picture numbers and cite only pictures that contribute. "
        "Do not guess obscured details or unreadable text."
    ),
}
