// A page that controls the 3D scene around it. It is served from another
// origin than the scene, so it cannot reach the parent window; it talks to the
// scene through the panel agent's messages instead.
import { onHostMessage, sendToHost } from "../../../src/agent/page";
import { SCENE_CLICK, type SceneControl } from "../../showcase/scene-events";

const form = document.querySelector<HTMLFormElement>("#form")!;
const clicks = document.querySelector<HTMLElement>("#clicks")!;

const send = (control: SceneControl) => sendToHost(control);

form.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === "shape") send({ shape: target.value as SceneControl["shape"] });
  if (target.name === "spin") send({ spin: target.checked });
});
const size = form.querySelector<HTMLInputElement>("[name=size]")!;
size.addEventListener("input", () => {
  form.querySelector("#size-out")!.textContent = `${size.value}%`;
  send({ scale: Number(size.value) / 100 });
});
form.querySelector<HTMLInputElement>("[name=caption]")!.addEventListener("input", (event) => {
  send({ caption: (event.target as HTMLInputElement).value });
});
for (const swatch of form.querySelectorAll<HTMLButtonElement>(".swatch")) {
  swatch.addEventListener("click", () => {
    form.querySelector(".swatch.selected")?.classList.remove("selected");
    swatch.classList.add("selected");
    send({ color: swatch.dataset.color });
  });
}
form.querySelector(".swatch")!.classList.add("selected");

// The other direction: the scene tells the page when the object is clicked.
let count = 0;
onHostMessage((data) => {
  if (data !== SCENE_CLICK) return;
  clicks.textContent = String(++count);
  clicks.classList.remove("bump");
  void clicks.offsetWidth;
  clicks.classList.add("bump");
});
