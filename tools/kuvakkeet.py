"""Tekee sovelluksen kuvakkeet: verkkoversion (app/icons) ja Android-sovelluksen
lähdekuvat (assets/), joista `npx capacitor-assets generate` tekee Android-kuvakkeet.

    python tools/kuvakkeet.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
NAVY = (31, 58, 95, 255)
GOLD = (224, 178, 92, 255)
S = 1024


def note(size, scale, bg=None, rounded=False):
    """Kahdeksasosanuottipari. scale = nuotin osuus kuvan leveydestä."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg and rounded:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=bg)
    elif bg:
        d.rectangle([0, 0, size, size], fill=bg)
    u = size * scale / 24
    o = (size - 24 * u) / 2
    P = lambda x, y: (o + x * u, o + y * u)
    d.polygon([P(7.93, 5.2), P(18.93, 3.0), P(18.93, 5.3), P(7.93, 7.5)], fill=GOLD)
    d.rectangle([P(7.93, 5.2), P(9.0, 18.5)], fill=GOLD)
    d.rectangle([P(17.86, 3.2), P(18.93, 15.5)], fill=GOLD)
    for cx, cy in [(6.5, 18.5), (16.43, 15.5)]:
        d.ellipse([P(cx - 2.6, cy - 2.1), P(cx + 2.6, cy + 2.1)], fill=GOLD)
    return img


def save(img, path, size=None, flatten=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    if flatten:
        bg = Image.new("RGBA", img.size, NAVY)
        bg.alpha_composite(img)
        img = bg.convert("RGB")
    img.save(path)


# Verkkoversio
icons = ROOT / "app" / "icons"
save(note(S, 0.75, NAVY, rounded=True), icons / "icon-192.png", 192)
save(note(S, 0.75, NAVY, rounded=True), icons / "icon-512.png", 512)
save(note(S, 0.75, NAVY, rounded=True), icons / "icon-180.png", 180, flatten=True)  # iOS ei tue läpinäkyvyyttä
save(note(S, 0.62, NAVY), icons / "maskable-512.png", 512)

# Android (Capacitor Assets): mukautuvan kuvakkeen etukuva pysyy keskimmäisen 66 %:n alueella.
assets = ROOT / "assets"
save(note(S, 0.70, NAVY), assets / "icon-only.png")
save(note(S, 0.46), assets / "icon-foreground.png")
save(Image.new("RGBA", (S, S), NAVY), assets / "icon-background.png")
splash = Image.new("RGBA", (2732, 2732), NAVY)
splash.alpha_composite(note(700, 0.9), (1016, 1016))
save(splash, assets / "splash.png")
save(splash, assets / "splash-dark.png")
print("Kuvakkeet tehty.")
