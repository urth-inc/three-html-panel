// Custom elements with shadow roots: one attached by script, with a slot for
// its label; one declared in the HTML (see index.html).

const result = document.querySelector<HTMLElement>("#result")!;
let rated = "Not rated.";
let pressed = 0;
const show = () => (result.textContent = `${rated} Pressed ${pressed} times.`);

// Five stars, as boxes: filled up to the value.
class Rating extends HTMLElement {
  static observedAttributes = ["value"];
  readonly #stars: HTMLButtonElement[] = [];

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { display: inline-grid; gap: 8px; }
        .stars { display: flex; gap: 6px; }
        button { all: unset; width: 32px; height: 32px; background: rgb(200 200 205); }
        button[aria-checked="true"] { background: rgb(245 160 10); }
      </style>
      <slot></slot>
      <div class="stars" role="radiogroup"></div>`;
    const stars = shadow.querySelector(".stars")!;
    for (let value = 1; value <= 5; value++) {
      const star = document.createElement("button");
      star.setAttribute("role", "radio");
      star.setAttribute("aria-label", `${value} stars`);
      star.addEventListener("click", () => this.setAttribute("value", String(value)));
      stars.append(star);
      this.#stars.push(star);
    }
  }

  attributeChangedCallback() {
    const value = Number(this.getAttribute("value")) || 0;
    this.#stars.forEach((star, index) => star.setAttribute("aria-checked", String(index < value)));
    rated = `Rated ${value}.`;
    show();
  }
}
customElements.define("x-rating", Rating);

// A closed shadow root, taller than the rest of the row: what follows is drawn
// where the page has it only if it is drawn.
customElements.define(
  "x-closed",
  class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "closed" }).innerHTML = `
        <style>:host { display: block; } div { width: 80px; height: 120px; background: rgb(20 150 170); }</style>
        <div></div>`;
    }
  },
);
customElements.define("x-badge", class extends HTMLElement {});

// Rated 2 to start with: only a press changes what it says.
rated = "Not rated.";
show();
document.querySelector("#after")!.addEventListener("click", () => {
  pressed++;
  show();
});

// Defined after the page has loaded: its shadow root is attached then, and
// what is in it changes later, with no change to the page's document.
class Late extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `
      <style>:host { display: block; width: 240px; height: 40px; } div { height: 100%; background: rgb(200 200 205); }</style>
      <div></div>`;
    setTimeout(() => {
      this.shadowRoot!.querySelector("div")!.style.background = "rgb(220 40 160)";
    }, 300);
  }
}
setTimeout(() => customElements.define("x-late", Late), 1000);
