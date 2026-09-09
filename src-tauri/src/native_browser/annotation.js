// Executed only by the native annotation command, never exposed as arbitrary page IPC.
(input) => {
  try {
    const key = '__tinybotAnnotationV1';
    if (input.type === 'start') {
      if (window[key]) throw new Error('Annotation is already active');
      const lifetime = new AbortController();
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      const shadow = host.attachShadow({ mode: 'closed' });
      const highlight = document.createElement('div');
      highlight.style.cssText = 'position:fixed;border:2px solid #2563eb;background:#2563eb18;box-sizing:border-box;display:none;pointer-events:none';
      shadow.append(highlight);
      document.documentElement.append(host);
      let selected = null;
      let original = null;
      let changes = {};
      let selectionId = 0;
      let region = null;
      let pressed = null;
      let regionMode = false;
      let exitRequested = false;
      let failure = '';
      const properties = ['color', 'background-color', 'font-size', 'font-weight', 'width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-radius', 'opacity'];
      const documentId = crypto.randomUUID();
      const rectOf = (rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      const pathOf = (element) => {
        const parts = [];
        for (let current = element; current && parts.length < 12; current = current.parentElement) {
          if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
            parts.unshift(`#${CSS.escape(current.id)}`); break;
          }
          const siblings = current.parentElement ? [...current.parentElement.children].filter((sibling) => sibling.localName === current.localName) : [];
          parts.unshift(`${current.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`);
        }
        return parts.join(' > ');
      };
      const show = (rect) => {
        Object.assign(highlight.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      };
      const assertSelected = () => {
        if (!selected || !selected.isConnected) throw new Error('The selected element changed. Select it again.');
        for (const [property, change] of Object.entries(changes)) {
          const actual = property === 'text' ? selected.textContent : selected.style.getPropertyValue(property);
          if (actual !== change.applied) throw new Error('The page changed during preview. Select the element again.');
        }
      };
      const restore = () => {
        if (selected?.isConnected) {
          // Restore only writes still owned by this preview; never overwrite a framework update.
          for (const [property, change] of Object.entries(changes)) {
            if (property === 'text') {
              if (selected.textContent === change.applied && !selected.children.length) selected.textContent = original.text;
            } else if (selected.style.getPropertyValue(property) === change.applied) {
              if (original.inline[property].value) selected.style.setProperty(property, original.inline[property].value, original.inline[property].priority);
              else selected.style.removeProperty(property);
            }
          }
        }
        changes = {};
      };
      const choose = (element) => {
        restore();
        if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) throw new Error('This element cannot be inspected');
        if (element.closest('input,textarea,select,[contenteditable="true"]')) throw new Error('Form values cannot be annotated. Use a region instead.');
        selected = element;
        selectionId += 1;
        region = null;
        failure = '';
        const computed = getComputedStyle(element);
        original = {
          text: element.children.length ? null : element.textContent,
          styles: Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)])),
          inline: Object.fromEntries(properties.map((property) => [property, { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) }])),
        };
        show(element.getBoundingClientRect());
      };
      const selection = () => {
        if (!selected) return null;
        assertSelected();
        return {
          id: selectionId, selector: pathOf(selected), tag: selected.localName,
          text: String(original.text ?? selected.textContent ?? '').slice(0, 2000),
          editableText: original.text !== null && original.text.length <= 2000, styles: original.styles,
          rect: rectOf(selected.getBoundingClientRect()),
          ancestors: [...(function* () { for (let node = selected.parentElement; node; node = node.parentElement) yield node; })()].slice(0, 8).map((node) => ({ tag: node.localName, selector: pathOf(node) })),
          changes: Object.fromEntries(Object.entries(changes).map(([property, change]) => [property, { before: property === 'text' ? original.text : original.styles[property], after: change.requested }])),
        };
      };
      const listen = (name, callback) => window.addEventListener(name, (event) => {
        try { callback(event); } catch (error) { failure = String(error.message || error); }
      }, { capture: true, signal: lifetime.signal, passive: false });
      const consume = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
      const updateDrag = (event) => {
        if (!pressed) return;
        if (!regionMode && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) {
          restore(); selected = null; regionMode = true; failure = '';
        }
        if (regionMode) {
          region = { x: Math.max(0, Math.min(pressed.x, event.clientX)), y: Math.max(0, Math.min(pressed.y, event.clientY)), width: Math.abs(event.clientX - pressed.x), height: Math.abs(event.clientY - pressed.y) };
          show(region);
        }
      };
      listen('pointerdown', (event) => {
        consume(event);
        if (event.button !== 0) return;
        pressed = { x: event.clientX, y: event.clientY, element: event.composedPath()[0] };
      });
      listen('pointermove', (event) => {
        consume(event);
        if (pressed) updateDrag(event);
        else if (!selected) {
          const element = event.composedPath()[0];
          if (element instanceof Element) show(element.getBoundingClientRect());
        }
      });
      listen('pointerup', (event) => {
        consume(event);
        if (!pressed) return;
        updateDrag(event);
        if (!regionMode) choose(pressed.element);
        else if (region && region.width >= 4 && region.height >= 4) selectionId += 1;
        else { region = null; highlight.style.display = 'none'; }
        pressed = null; regionMode = false;
      });
      listen('pointercancel', () => {
        pressed = null; regionMode = false; region = null;
        if (selected?.isConnected) show(selected.getBoundingClientRect());
        else highlight.style.display = 'none';
      });
      for (const name of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'dragstart']) listen(name, consume);
      listen('keydown', (event) => {
        consume(event);
        if (event.key === 'Escape') {
          if (pressed || selected || region) { restore(); pressed = null; regionMode = false; selected = null; region = null; highlight.style.display = 'none'; }
          else exitRequested = true;
        }
      });
      listen('keyup', consume);
      listen('scroll', () => { if (selected?.isConnected) show(selected.getBoundingClientRect()); });
      window[key] = (action) => {
        if (action.type === 'stop') {
          restore(); lifetime.abort(); host.remove(); delete window[key];
          return { active: false };
        }
        if (action.documentId && action.documentId !== documentId) throw new Error('The page changed. Restart annotation.');
        if (['preview', 'parent', 'reset'].includes(action.type)) {
          if (action.selectionId !== selectionId) throw new Error('The selected element changed. Select it again.');
          assertSelected();
        }
        if (action.type === 'parent') {
          let ancestor = selected;
          for (let index = 0; index <= action.index; index += 1) ancestor = ancestor?.parentElement;
          if (!ancestor) throw new Error('The parent element is no longer available');
          choose(ancestor);
        }
        if (action.type === 'reset') { restore(); show(selected.getBoundingClientRect()); }
        if (action.type === 'preview') {
          const property = action.property;
          const value = action.value;
          if (typeof value !== 'string' || value.length > 2000) throw new Error('Invalid property value');
          if (property === 'text') {
            if (original.text === null || original.text.length > 2000 || selected.children.length) throw new Error('Select a text element without child elements');
            if (!changes.text && selected.textContent !== original.text) throw new Error('The page text changed. Select it again.');
            selected.textContent = value;
            changes.text = { requested: value, applied: selected.textContent };
            if (value === original.text) delete changes.text;
          } else {
            if (!properties.includes(property) || !CSS.supports(property, value) || /url\s*\(|var\s*\(|[;{}]/i.test(value)) throw new Error('Unsupported CSS value');
            if (!changes[property] && (selected.style.getPropertyValue(property) !== original.inline[property].value || selected.style.getPropertyPriority(property) !== original.inline[property].priority)) throw new Error('The page style changed. Select it again.');
            selected.style.setProperty(property, value, 'important');
            changes[property] = { requested: value, applied: selected.style.getPropertyValue(property) };
            if (value === original.styles[property] || changes[property].applied === original.styles[property]) {
              if (original.inline[property].value) selected.style.setProperty(property, original.inline[property].value, original.inline[property].priority);
              else selected.style.removeProperty(property);
              delete changes[property];
            }
          }
          show(selected.getBoundingClientRect());
        }
        if (action.type === 'hideOverlay') host.style.visibility = 'hidden';
        if (action.type === 'showOverlay') host.style.visibility = 'visible';
        if (action.type === 'clear') { restore(); pressed = null; regionMode = false; selected = null; region = null; highlight.style.display = 'none'; failure = ''; }
        if (failure && action.type !== 'clear') throw new Error(failure);
        return {
          active: true, documentId, selectionId, selection: selection(),
          region: pressed ? null : region, exitRequested,
          url: location.href, title: document.title,
          viewport: { width: innerWidth, height: innerHeight, deviceScale: devicePixelRatio, scrollX, scrollY },
        };
      };
    }
    if (!window[key]) {
      if (input.type === 'stop') return { ok: true, value: { active: false } };
      throw new Error('The page changed. Restart annotation.');
    }
    return { ok: true, value: window[key](input) };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
}
