const MODULE_ID = "character-forge";
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

class CharacterForgeData {
  static #cache = null;
  static #loading = null;

  static async load() {
    if (this.#cache) return this.#cache;
    if (this.#loading) return this.#loading;
    this.#loading = this.#loadInternal();
    try {
      this.#cache = await this.#loading;
      return this.#cache;
    } finally {
      this.#loading = null;
    }
  }

  static clear() {
    this.#cache = null;
  }

  static async #loadInternal() {
    const buckets = { class: [], race: [], background: [] };
    const packs = Array.from(game.packs ?? []).filter(pack => pack.documentName === "Item");

    const concurrency = 4;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, packs.length) }, async () => {
      while (cursor < packs.length) {
        const pack = packs[cursor++];
        let index;
        try {
          index = await pack.getIndex({ fields: ["name", "type", "img", "system.identifier"] });
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to index ${pack.collection}`, error);
          continue;
        }

        for (const entry of index) {
          if (!Object.hasOwn(buckets, entry.type)) continue;
          buckets[entry.type].push({
            id: `${pack.collection}.${entry._id}`,
            uuid: `Compendium.${pack.collection}.${entry._id}`,
            name: entry.name,
            img: entry.img || "icons/svg/item-bag.svg",
            pack: pack.metadata?.label || pack.title || pack.collection,
            identifier: entry.system?.identifier || ""
          });
        }
      }
    });

    await Promise.all(workers);
    for (const items of Object.values(buckets)) {
      items.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    }
    return buckets;
  }
}

class CharacterForgeWizard {
  constructor() {
    this.step = 0;
    this.data = {
      name: "",
      classUuid: "",
      raceUuid: "",
      backgroundUuid: "",
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
    };
    this.catalog = { class: [], race: [], background: [] };
    this.root = null;
    this.busy = false;
  }

  async open() {
    if (document.getElementById("character-forge-overlay")) return;
    this.root = document.createElement("div");
    this.root.id = "character-forge-overlay";
    this.root.className = "character-forge-overlay";
    this.root.innerHTML = `<div class="character-forge-shell"><div class="cf-loading"><i class="fas fa-spinner fa-spin"></i><span>${game.i18n.localize("CF.Loading")}</span></div></div>`;
    document.body.appendChild(this.root);
    this.root.addEventListener("click", event => {
      if (event.target === this.root) this.close();
    });

    try {
      this.catalog = await CharacterForgeData.load();
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to open wizard`, error);
      ui.notifications?.error(game.i18n.localize("CF.LoadFailed"));
      this.close();
    }
  }

  close() {
    this.root?.remove();
    this.root = null;
  }

  localize(key) {
    return game.i18n.localize(key);
  }

  render() {
    if (!this.root) return;
    const shell = this.root.querySelector(".character-forge-shell");
    const titles = ["CF.StepBasics", "CF.StepOrigins", "CF.StepAbilities", "CF.StepReview"];
    shell.innerHTML = `
      <header class="cf-header">
        <div>
          <h1>${this.localize("CF.Title")}</h1>
          <p>${this.localize(titles[this.step])}</p>
        </div>
        <button type="button" class="cf-icon-button" data-action="close" aria-label="${this.localize("CF.Close")}"><i class="fas fa-xmark"></i></button>
      </header>
      <nav class="cf-progress">${[0,1,2,3].map(index => `<span class="${index <= this.step ? "active" : ""}">${index + 1}</span>`).join("")}</nav>
      <main class="cf-content">${this.stepContent()}</main>
      <footer class="cf-footer">
        <button type="button" data-action="back" ${this.step === 0 || this.busy ? "disabled" : ""}><i class="fas fa-arrow-left"></i> ${this.localize("CF.Back")}</button>
        ${this.step < 3
          ? `<button type="button" class="primary" data-action="next" ${this.busy ? "disabled" : ""}>${this.localize("CF.Next")} <i class="fas fa-arrow-right"></i></button>`
          : `<button type="button" class="primary" data-action="create" ${this.busy ? "disabled" : ""}><i class="fas fa-hammer"></i> ${this.localize("CF.Create")}</button>`}
      </footer>`;

    this.bind(shell);
  }

  stepContent() {
    switch (this.step) {
      case 0: return this.basicsStep();
      case 1: return this.originsStep();
      case 2: return this.abilitiesStep();
      default: return this.reviewStep();
    }
  }

  basicsStep() {
    return `
      <section class="cf-panel">
        <label class="cf-field">
          <span>${this.localize("CF.CharacterName")}</span>
          <input name="name" type="text" autocomplete="off" value="${foundry.utils.escapeHTML(this.data.name)}" placeholder="${this.localize("CF.NamePlaceholder")}">
        </label>
        <p class="cf-hint">${this.localize("CF.BasicsHint")}</p>
      </section>`;
  }

  originsStep() {
    return `
      <section class="cf-grid three">
        ${this.selectCard("raceUuid", "CF.Race", this.catalog.race, this.data.raceUuid)}
        ${this.selectCard("backgroundUuid", "CF.Background", this.catalog.background, this.data.backgroundUuid)}
        ${this.selectCard("classUuid", "CF.Class", this.catalog.class, this.data.classUuid)}
      </section>
      <p class="cf-hint">${this.localize("CF.OriginsHint")}</p>`;
  }

  selectCard(name, labelKey, items, value) {
    const options = [`<option value="">${this.localize("CF.None")}</option>`]
      .concat(items.map(item => `<option value="${item.uuid}" ${item.uuid === value ? "selected" : ""}>${foundry.utils.escapeHTML(item.name)} — ${foundry.utils.escapeHTML(item.pack)}</option>`));
    return `<label class="cf-panel cf-field"><span>${this.localize(labelKey)}</span><select name="${name}">${options.join("")}</select></label>`;
  }

  abilitiesStep() {
    return `
      <section class="cf-panel">
        <div class="cf-ability-toolbar">
          <strong>${this.localize("CF.Abilities")}</strong>
          <button type="button" data-action="standard-array">${this.localize("CF.StandardArray")}</button>
        </div>
        <div class="cf-abilities">
          ${ABILITIES.map(key => `<label><span>${CONFIG.DND5E?.abilities?.[key]?.label || key.toUpperCase()}</span><input name="ability-${key}" type="number" min="3" max="20" step="1" value="${this.data.abilities[key]}"></label>`).join("")}
        </div>
      </section>
      <p class="cf-hint">${this.localize("CF.AbilitiesHint")}</p>`;
  }

  reviewStep() {
    const lookup = uuid => {
      for (const list of Object.values(this.catalog)) {
        const found = list.find(item => item.uuid === uuid);
        if (found) return found.name;
      }
      return this.localize("CF.None");
    };
    return `
      <section class="cf-panel cf-review">
        <h2>${foundry.utils.escapeHTML(this.data.name || this.localize("CF.Unnamed"))}</h2>
        <dl>
          <dt>${this.localize("CF.Race")}</dt><dd>${foundry.utils.escapeHTML(lookup(this.data.raceUuid))}</dd>
          <dt>${this.localize("CF.Background")}</dt><dd>${foundry.utils.escapeHTML(lookup(this.data.backgroundUuid))}</dd>
          <dt>${this.localize("CF.Class")}</dt><dd>${foundry.utils.escapeHTML(lookup(this.data.classUuid))}</dd>
        </dl>
        <div class="cf-review-abilities">${ABILITIES.map(key => `<div><span>${key.toUpperCase()}</span><strong>${this.data.abilities[key]}</strong></div>`).join("")}</div>
        <p class="cf-warning"><i class="fas fa-circle-info"></i> ${this.localize("CF.ReviewHint")}</p>
      </section>`;
  }

  bind(shell) {
    shell.querySelectorAll("input, select").forEach(element => {
      element.addEventListener("change", () => this.capture(shell));
      element.addEventListener("input", () => this.capture(shell));
    });

    shell.querySelectorAll("[data-action]").forEach(button => {
      button.addEventListener("click", async event => {
        const action = event.currentTarget.dataset.action;
        if (action === "close") return this.close();
        if (action === "back") {
          this.capture(shell);
          this.step = Math.max(0, this.step - 1);
          return this.render();
        }
        if (action === "next") {
          this.capture(shell);
          if (!this.validateStep()) return;
          this.step = Math.min(3, this.step + 1);
          return this.render();
        }
        if (action === "standard-array") {
          const values = [15, 14, 13, 12, 10, 8];
          ABILITIES.forEach((key, index) => this.data.abilities[key] = values[index]);
          return this.render();
        }
        if (action === "create") {
          this.capture(shell);
          if (!this.validateStep()) return;
          await this.createActor();
        }
      });
    });
  }

  capture(shell) {
    const read = name => shell.querySelector(`[name="${name}"]`)?.value ?? "";
    if (shell.querySelector('[name="name"]')) this.data.name = read("name").trim();
    for (const key of ["classUuid", "raceUuid", "backgroundUuid"]) {
      if (shell.querySelector(`[name="${key}"]`)) this.data[key] = read(key);
    }
    for (const key of ABILITIES) {
      const input = shell.querySelector(`[name="ability-${key}"]`);
      if (input) this.data.abilities[key] = Number(input.value);
    }
  }

  validateStep() {
    if (this.step === 0 && !this.data.name) {
      ui.notifications?.warn(this.localize("CF.NameRequired"));
      return false;
    }
    if (this.step === 2 || this.step === 3) {
      const invalid = ABILITIES.some(key => !Number.isInteger(this.data.abilities[key]) || this.data.abilities[key] < 3 || this.data.abilities[key] > 20);
      if (invalid) {
        ui.notifications?.warn(this.localize("CF.AbilitiesInvalid"));
        return false;
      }
    }
    return true;
  }

  async createActor() {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const abilities = Object.fromEntries(ABILITIES.map(key => [key, { value: this.data.abilities[key] }]));
      const actor = await Actor.create({
        name: this.data.name,
        type: "character",
        system: { abilities }
      });
      if (!actor) throw new Error("Actor.create returned no actor");

      const uuids = [this.data.raceUuid, this.data.backgroundUuid, this.data.classUuid].filter(Boolean);
      const docs = [];
      for (const uuid of uuids) {
        try {
          const item = await fromUuid(uuid);
          if (!item) continue;
          const source = item.toObject();
          delete source._id;
          docs.push(source);
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to import ${uuid}`, error);
        }
      }
      if (docs.length) await actor.createEmbeddedDocuments("Item", docs);

      ui.notifications?.info(game.i18n.format("CF.Created", { name: actor.name }));
      this.close();
      actor.sheet?.render(true);
    } catch (error) {
      console.error(`${MODULE_ID} | Character creation failed`, error);
      ui.notifications?.error(this.localize("CF.CreateFailed"));
      this.busy = false;
      this.render();
    }
  }
}

function insertDirectoryButton(html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".character-forge-open")) return;

  const target = root.querySelector(".directory-header .header-actions, .directory-header, header");
  if (!target) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "character-forge-open";
  button.innerHTML = `<i class="fas fa-hammer"></i><span>${game.i18n.localize("CF.Open")}</span>`;
  button.addEventListener("click", () => new CharacterForgeWizard().open());
  target.appendChild(button);
}

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    open: () => new CharacterForgeWizard().open(),
    clearCache: () => CharacterForgeData.clear()
  };
});

Hooks.on("renderActorDirectory", (_app, html) => insertDirectoryButton(html));
Hooks.on("renderActorDirectoryApplicationV2", (_app, html) => insertDirectoryButton(html));
