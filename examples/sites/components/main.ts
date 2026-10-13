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
customElements.define("x-badge", class extends HTMLElement {});

// Rated 2 to start with: only a press changes what it says.
rated = "Not rated.";
show();
document.querySelector("#after")!.addEventListener("click", () => {
  pressed++;
  show();
});
