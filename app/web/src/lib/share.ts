"use client";
// Shareable objects.
//
// Nobody shares a FORM. In Venezuela what spread were CARDS — a face, a name, a
// place — because a family was begging their own network to find one specific
// person. Distribution was a by-product of a private search. So every report has
// to produce an object that is worth forwarding, and it has to be produced ON THE
// DEVICE so it also works with no signal.
//
// Two formats:
//   "link"  1200×630  — WhatsApp/OG link preview (a link that renders as an empty
//                       grey rectangle reads as phishing and does not get forwarded)
//   "story" 1080×1920 — WhatsApp Status / Instagram Story / Facebook Story
import qrcode from "qrcode-generator";
import { PublicCardData } from "./publicView";

export type CardFormat = "link" | "story";

const C = {
  // Paper-and-ink, matching the site. A dark card with an orange accent looked
  // like every AI-built landing page; a cream poster with heavy ink type reads as
  // an official notice, which is what makes a stranger forward it.
  bg: "#f3efe5",
  panel: "#fbf9f3",
  line: "#d9d2c2",
  text: "#16232f",
  muted: "#5d6b78",
  accent: "#1d4e89",
  danger: "#a3251c",
  ok: "#1c6b3f",
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Shrink until it fits. A long Colombian compound name must never be clipped —
// it is the single most important pixel on the card.
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startPx: number, minPx: number, weight = 700) {
  let size = startPx;
  while (size > minPx) {
    ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("image"));
    i.src = src;
  });
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, blur: boolean) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 28);
  ctx.clip();
  // Minors are blurred even when publication was authorised (form-spec, privacy).
  if (blur) ctx.filter = "blur(26px)";
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.filter = "none";
  ctx.restore();
}

function drawInitials(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, w: number, h: number) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 28);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
  ctx.fillStyle = C.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(h * 0.34)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(initials || "?", x + w / 2, y + h / 2 - h * 0.06);
  ctx.font = `500 ${Math.round(h * 0.075)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("sin foto", x + w / 2, y + h / 2 + h * 0.22);
  ctx.restore();
}

function drawQr(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  const qr = qrcode(0, "M"); // auto version, medium ECC — survives a photo of a screen
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, size, size, 16);
  ctx.fill();
  ctx.fillStyle = "#000000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
}

function badgeColour(d: PublicCardData) {
  if (d.found) return C.ok;
  if (d.urgent) return C.danger;
  return C.accent;
}

async function draw(d: PublicCardData, format: CardFormat): Promise<HTMLCanvasElement> {
  const W = format === "story" ? 1080 : 1200;
  const H = format === "story" ? 1920 : 630;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = badgeColour(d);
  ctx.fillRect(0, 0, W, 12);

  const img = d.photo ? await loadImage(d.photo).catch(() => null) : null;
  const accent = badgeColour(d);

  const label = (t: string, x: number, y: number, px: number) => {
    ctx.font = `700 ${px}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = C.muted;
    ctx.fillText(t.toUpperCase(), x, y);
  };

  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  if (format === "story") {
    const pad = 80;
    // status pill
    ctx.font = "700 34px ui-sans-serif, system-ui, sans-serif";
    const pillW = ctx.measureText(d.statusLabel).width + 56;
    roundRect(ctx, pad, 110, pillW, 68, 34);
    ctx.fillStyle = accent;
    ctx.fill();
    // The pill is now a saturated ink colour, so its text must be paper-white.
    ctx.fillStyle = "#ffffff";
    ctx.fillText(d.statusLabel, pad + 28, 110 + 18);

    const photoSize = W - pad * 2;
    const photoY = 220;
    if (img) drawCover(ctx, img, pad, photoY, photoSize, photoSize, d.blurPhoto);
    else drawInitials(ctx, d.name, pad, photoY, photoSize, photoSize);

    let y = photoY + photoSize + 60;
    const nameSize = fitText(ctx, d.name, W - pad * 2, 86, 44);
    ctx.fillStyle = C.text;
    ctx.fillText(d.name, pad, y);
    y += nameSize + 24;

    ctx.font = "500 40px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = C.muted;
    if (d.ageLine) {
      ctx.fillText(d.ageLine, pad, y);
      y += 54;
    }
    ctx.fillText(`Visto por última vez: ${d.area}`, pad, y);
    y += 78;

    // The ask, in plain words. A card without an explicit request gets looked at
    // and scrolled past; a card that asks gets forwarded.
    ctx.font = "600 38px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = C.text;
    const ask = d.found
      ? "Gracias a todos los que compartieron."
      : `Ayúdanos a encontrarl${d.gsuffix}. Comparte esta imagen.`;
    for (const line of wrap(ctx, ask, W - pad * 2)) {
      ctx.fillText(line, pad, y);
      y += 50;
    }

    // QR + call to action
    const qrSize = 300;
    const qrY = H - pad - qrSize - 40;
    drawQr(ctx, d.url, pad, qrY, qrSize);

    const tx = pad + qrSize + 44;
    ctx.fillStyle = C.text;
    ctx.font = "700 44px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`¿L${d.gsuffix} has visto?`, tx, qrY + 10);
    ctx.font = "500 32px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = C.muted;
    ctx.fillText("Escanea el código o entra a", tx, qrY + 78);
    ctx.fillStyle = accent;
    const urlSize = fitText(ctx, d.url.replace(/^https?:\/\//, ""), W - tx - pad, 34, 20, 700);
    ctx.fillText(d.url.replace(/^https?:\/\//, ""), tx, qrY + 124);
    ctx.fillStyle = C.muted;
    ctx.font = "500 30px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`Ref. ${d.reference}`, tx, qrY + 124 + urlSize + 26);

    ctx.fillStyle = C.muted;
    ctx.font = "500 28px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(d.incidentName, pad, H - pad + 8);
  } else {
    const pad = 56;
    const photoSize = H - pad * 2;
    if (img) drawCover(ctx, img, pad, pad, photoSize, photoSize, d.blurPhoto);
    else drawInitials(ctx, d.name, pad, pad, photoSize, photoSize);

    const x = pad + photoSize + 48;
    const maxW = W - x - pad - 200;
    let y = pad + 10;

    ctx.font = "700 26px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText(d.statusLabel, x, y);
    y += 50;

    const nameSize = fitText(ctx, d.name, maxW + 160, 62, 32);
    ctx.fillStyle = C.text;
    ctx.fillText(d.name, x, y);
    y += nameSize + 20;

    ctx.font = "500 28px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = C.muted;
    if (d.ageLine) {
      ctx.fillText(d.ageLine, x, y);
      y += 42;
    }
    ctx.fillText(`Visto por última vez: ${d.area}`, x, y);

    const qrSize = 190;
    drawQr(ctx, d.url, W - pad - qrSize, H - pad - qrSize, qrSize);

    ctx.fillStyle = C.text;
    ctx.font = "700 30px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`¿L${d.gsuffix} has visto?`, x, H - pad - 96);
    ctx.font = "500 24px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = C.muted;
    ctx.fillText(`${d.url.replace(/^https?:\/\//, "")} · Ref. ${d.reference}`, x, H - pad - 52);
    label(d.incidentName, x, pad - 34, 20);
  }

  return canvas;
}

export async function renderCardDataUrl(card: PublicCardData, format: CardFormat): Promise<string> {
  const canvas = await draw(card, format);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export async function renderCardFile(card: PublicCardData, format: CardFormat): Promise<File> {
  const canvas = await draw(card, format);
  const blob: Blob = await new Promise((res) =>
    canvas.toBlob((b) => res(b!), "image/jpeg", 0.9)
  );
  return new File([blob], `${card.reference}-${format}.jpg`, { type: "image/jpeg" });
}

// The message the family actually sends. Written as a person begging their own
// network — not as a platform announcement.
export function shareText(d: PublicCardData): string {
  const lines = [
    `🔴 ${d.statusLabel}: ${d.name}${d.ageLine ? ` (${d.ageLine})` : ""}`,
    `Visto por última vez: ${d.area}`,
    `${d.incidentName}`,
    "",
    `Si l${d.gsuffix} has visto, o si sabes algo, entra aquí:`,
    d.url,
    "",
    `Ref. ${d.reference}`,
  ];
  return lines.join("\n");
}

export function whatsappShareUrl(card: PublicCardData): string {
  return `https://wa.me/?text=${encodeURIComponent(shareText(card))}`;
}

export function canShareFiles(file: File): boolean {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  return typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] });
}

export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
