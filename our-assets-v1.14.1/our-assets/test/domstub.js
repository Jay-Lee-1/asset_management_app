#!/usr/bin/env node
/* 의존성 없는 최소 DOM shim — jsdom 등 외부 패키지를 설치하지 않는 이 테스트 스위트의 제로-빌드
 * 원칙을 지키면서, closest()/querySelector() 같은 실DOM 조작이 섞여 있어 지금까지 run.js가
 * "jsdom이 없어 실행형으로 못 돌리므로 소스 문자열 정규식으로 대신한다"고 적어온 함수들을
 * 실제로 실행해 검증할 수 있게 한다(app-evolve cycle209 critique → cycle210 advance).
 *
 * 범용 DOM 구현이 아니다 — 이 스위트가 실제로 쓰는 만큼만 지원한다: 셀렉터는 '#id'/'.class'/
 * '[attr]'/'tag' 단일 토큰(쉼표로 여러 개 OR)만 지원하고, 자손/자식 결합자(공백, >)는 없다.
 * innerHTML 대입은 이제(app-evolve cycle366 critique→advance) parseHTMLInto()로 실제 자식
 * 엘리먼트도 함께 만든다 — openSheet()처럼 그 결과를 querySelector()로 되읽는 함수를 실행형으로
 * 돌리기 위함이다(getter는 여전히 원본 문자열 그대로 반환). 다만 텍스트 노드는 만들지 않고,
 * 속성값은 쌍따옴표로 감싼 소스만, 비-void 엘리먼트의 self-close(`<div/>`)는 지원하지 않는다 —
 * 이 스위트가 테스트 안에서 직접 작성하는 고정 fixture 전용 파서다.
 */
'use strict';

function matchesSimple(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return el.classList.contains(sel.slice(1));
  // [attr] 속성 셀렉터 — sheetFocusables()의 'button,[href],input,select,textarea,[tabindex]'처럼
  // 포커스 가능 엘리먼트를 고르는 데 실제로 쓰여서(app-evolve cycle366 critique→advance) 추가했다.
  // '[attr=val]' 값 매칭까지는 이 스위트가 아직 쓰지 않아 지원하지 않는다.
  if (sel[0] === '[' && sel[sel.length - 1] === ']') return el.hasAttribute(sel.slice(1, -1));
  return el.tagName === sel.toLowerCase();
}

function matches(el, selector) {
  return selector.split(',').some((sel) => matchesSimple(el, sel));
}

class ClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach((n) => this._set.add(n)); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : !!force;
    if (on) this._set.add(name); else this._set.delete(name);
    return on;
  }
  contains(name) { return this._set.has(name); }
  get value() { return Array.from(this._set).join(' '); }
}

class DomNode {
  constructor(tagName) {
    this.tagName = String(tagName).toLowerCase();
    this.classList = new ClassList();
    this.children = [];
    this.parentNode = null;
    this._attrs = {};
    this._innerHTML = '';
    this._listeners = {};
    // style/dataset: ensureEdgeGesture()의 makePrev()가 document.createElement로 만든 요소에
    // 바로 .style.height=.../.dataset.top=...를 대입한다(app-evolve cycle210 advance) — 실제
    // CSSStyleDeclaration/DOMStringMap을 흉내 낼 필요 없이 이 스위트는 대입/읽기만 하므로 평범한
    // 객체로 충분하다.
    this.style = {};
    this.dataset = {};
  }
  get id() { return this._attrs.id || ''; }
  set id(v) { this.setAttribute('id', v); }
  get type() { return this._attrs.type || 'text'; }
  set type(v) { this.setAttribute('type', v); }
  get value() { return this._attrs.value || ''; }
  set value(v) { this._attrs.value = String(v); }
  // disabled/tabIndex: sheetFocusables()가 포커스 가능 엘리먼트를 걸러내는 데 직접 읽는
  // 두 속성(app-evolve cycle366 critique→advance) — 그 외 쓰임은 없어 더 넓히지 않는다.
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get tabIndex() { return this.hasAttribute('tabindex') ? parseInt(this.getAttribute('tabindex'), 10) : 0; }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  setAttribute(name, v) { this._attrs[name] = String(v); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  removeAttribute(name) { delete this._attrs[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
  get innerHTML() { return this._innerHTML; }
  // openSheet()처럼 innerHTML에 템플릿 문자열을 통째로 꽂은 뒤 querySelector('h3,.pk-h')로
  // 그 결과를 되읽는 함수를 실행형으로 돌리려면(app-evolve cycle366 critique→advance) 문자열을
  // 저장만 하던 예전 방식으론 부족해 parseHTMLInto()로 실제 자식 엘리먼트도 함께 만든다.
  // getter는 여전히 원본 문자열을 그대로 돌려줘(기존 lastSheetHtml류 비교 테스트와 호환) 이원화한다.
  set innerHTML(html) { this._innerHTML = String(html); this.children = []; parseHTMLInto(this, this._innerHTML); }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text || '';
  }
  set textContent(v) { this._text = String(v); this.children = []; this._innerHTML = ''; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  // makePrev()가 "현재 시트 바로 앞(뒤 z)"에 미리보기 요소를 끼워넣을 때 쓴다
  // (sh.parentNode.insertBefore(pv,sh), app-evolve cycle210 advance).
  insertBefore(newNode, refNode) {
    newNode.parentNode = this;
    const idx = this.children.indexOf(refNode);
    if (idx === -1) this.children.push(newNode);
    else this.children.splice(idx, 0, newNode);
    return newNode;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  // contains()/focus()/getBoundingClientRect(): closeSheet()의 "포커스 반환"
  // (`if(rf&&document.contains(rf))rf.focus()`)과 openSheet()의 포커스 트랩
  // (`!sh.contains(document.activeElement)`), ensureEdgeGesture()의 높이 계산을
  // 실행형으로 돌리는 데 필요해 추가했다(app-evolve cycle366 critique→advance).
  // getBoundingClientRect는 레이아웃이 없는 이 shim에서 늘 0 사각형 — 실제 치수가
  // 필요한 기존 테스트는 지금까지처럼 인스턴스별로 직접 덮어써서 쓴다.
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  focus() { _activeElement = this; }
  blur() { if (_activeElement === this) _activeElement = null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  _descendants() {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelectorAll(selector) {
    return this._descendants().filter((n) => matches(n, selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }
  removeEventListener(type, fn) {
    if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }
  dispatchEvent(evt) {
    (this._listeners[evt.type] || []).forEach((fn) => fn(evt));
    return true;
  }
}

function createElement(tagName) { return new DomNode(tagName); }

// document.activeElement — DomNode.focus()/blur()가 갱신하는 모듈 스코프 변수 하나로 추적한다
// (실제 브라우저처럼 문서당 하나뿐이라는 가정; createDocument() 호출마다 그 문서의 body로
// 리셋되므로 테스트 간 상태가 새지 않는다. 동시에 여러 document를 함께 조작하는 테스트는
// 이 스위트에 없다). app-evolve cycle366 critique→advance.
let _activeElement = null;

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG_RE = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/g;

function applyAttrs(el, attrsStr) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrsStr))) {
    const name = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    el.setAttribute(name, val);
    if (name === 'class') val.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
  }
}

// openSheet() 등이 innerHTML에 꽂는 템플릿 문자열을 querySelector()로 되읽는 코드를 실행형으로
// 돌리기 위한 가벼운 태그 소스 파서(app-evolve cycle366 critique→advance, domstub.js 맨 위 설명의
// "실제 파싱이 필요한 함수가 생기면 그때 확장한다"가 가리키던 그 확장). 텍스트 노드는 만들지 않고
// (이 스위트의 테스트는 지금까지 엘리먼트 구조·속성만 필요로 함), 속성값은 항상 쌍따옴표로 감싼
// 소스만 지원한다 — 범용 HTML 파서가 아니라 이 스위트가 테스트 안에서 직접 작성하는 고정 fixture
// 전용이다. 비-void 엘리먼트의 self-close(`<div/>`)는 지원하지 않는다(그런 fixture를 쓰지 않음).
function parseHTMLInto(container, html) {
  TAG_RE.lastIndex = 0;
  const stack = [container];
  let m;
  while ((m = TAG_RE.exec(html))) {
    if (m[1]) {
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === name) { stack.length = i; break; }
      }
    } else {
      const name = m[2].toLowerCase();
      const el = createElement(name);
      applyAttrs(el, m[3] || '');
      stack[stack.length - 1].appendChild(el);
      if (!VOID_TAGS.has(name)) stack.push(el);
    }
  }
}

function createDocument() {
  const body = createElement('body');
  _activeElement = body; // 실제 브라우저도 포커스된 게 없으면 document.activeElement===document.body
  return {
    body,
    createElement,
    getElementById(id) { return body.querySelector(`#${id}`); },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
    contains(node) { return node === body || body.contains(node); },
    get activeElement() { return _activeElement; },
  };
}

module.exports = { createDocument, createElement, DomNode };
