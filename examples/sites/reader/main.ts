// A page with what a reader or an editor has: text to select and copy,
// drop-down lists, a contenteditable box, a video and a picture. Nothing in it knows that
// it is shown in 3D.

const editor = document.querySelector<HTMLElement>("#editor")!;
const wordCount = document.querySelector<HTMLElement>("#status")!;
const font = document.querySelector<HTMLSelectElement>("#font")!;
const size = document.querySelector<HTMLSelectElement>("#size")!;

// A list box: Ctrl (Cmd on macOS) adds a tag, Shift a range.
const tags = document.querySelector<HTMLSelectElement>("#tags")!;
const tagList = document.querySelector<HTMLElement>("#tag-list")!;
tags.addEventListener("change", () => {
  const chosen = Array.from(tags.selectedOptions, (option) => option.text);
  tagList.textContent = chosen.length ? `Tags: ${chosen.join(", ")}` : "No tags";
});

const applyFont = () => {
  editor.style.fontFamily = font.value;
  editor.style.fontSize = size.value;
};
font.addEventListener("change", applyFont);
size.addEventListener("change", applyFont);
applyFont();

const countWords = () => {
  const words = editor.innerText.trim().split(/\s+/).filter(Boolean).length;
  wordCount.textContent = `Words: ${words}`;
};
editor.addEventListener("input", countWords);
countWords();

// The video plays a clip drawn on a canvas here, so that the demo needs no
// video file: a ball bouncing over a gradient.
const video = document.querySelector<HTMLVideoElement>("#video")!;
const play = document.querySelector<HTMLButtonElement>("#play")!;
const canvas = document.createElement("canvas");
canvas.width = 320;
canvas.height = 180;
const context = canvas.getContext("2d")!;
let start = performance.now();
const draw = (now: number) => {
  const t = (now - start) / 1000;
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, `hsl(${(t * 40) % 360} 70% 45%)`);
  gradient.addColorStop(1, `hsl(${(t * 40 + 120) % 360} 70% 35%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const x = 30 + ((Math.sin(t * 1.3) + 1) / 2) * (canvas.width - 60);
  const y = canvas.height - 30 - Math.abs(Math.sin(t * 3)) * (canvas.height - 60);
  context.fillStyle = "#fff";
  context.beginPath();
  context.arc(x, y, 18, 0, Math.PI * 2);
  context.fill();
  context.font = "14px system-ui";
  context.fillText(`${t.toFixed(1)} s`, 10, 22);
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
// requestAnimationFrame may be held back in the panel's iframe; a timer keeps the clip moving.
setInterval(() => draw(performance.now()), 1000 / 30);
video.srcObject = canvas.captureStream(30);

play.addEventListener("click", () => {
  if (video.paused) {
    start = performance.now();
    void video.play();
  } else {
    video.pause();
  }
});
video.addEventListener("play", () => (play.textContent = "Pause"));
video.addEventListener("pause", () => (play.textContent = "Play"));
