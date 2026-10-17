#!/usr/bin/env node
/* 의존성 없는 최소 DOM shim — jsdom 등 외부 패키지를 설치하지 않는 이 테스트 스위트의 제로-빌드
 * 원칙을 지키면서, closest()/querySelector() 같은 실DOM 조작이 섞여 있어 지금까지 run.js가
 * "jsdom이 없어 실행형으로 못 돌리므로 소스 문자열 정규식으로 대신한다"고 적어온 함수들을
 * 실제로 실행해 검증할 수 있게 한다(app-evolve cycle209 critique → cycle210 advance).
 *
 * 범용 DOM 구현이 아니다 — 이 스위트가 실제로 쓰는 만큼만 지원한다: 셀렉터는 '#id'/'.class'/
 * 'tag' 단일 토큰(쉼표로 여러 개 OR)만 지원하고, 자손/자식 결합자(공백, >)는 없다.
 * innerHTML은 실제 HTML 파싱 없이 문자열을 그대로 저장/반환한다(이 스위트가 지금 끌어오는
 * 함수들은 innerHTML을 쓰기만 하고 그 결과를 되읽어 파싱하지 않기 때문 — 실제 파싱이 필요한
 * 함수(openSheet 등)가 생기면 그때 확장한다).
 */
'use strict';

function matchesSimple(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return el.classList.contains(sel.slice(1));
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
  setAttribute(name, v) { this._attrs[name] = String(v); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  removeAttribute(name) { delete this._attrs[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(html) { this._innerHTML = String(html); this.children = []; }
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

function createDocument() {
  const body = createElement('body');
  return {
    body,
    createElement,
    getElementById(id) { return body.querySelector(`#${id}`); },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
}

module.exports = { createDocument, createElement, DomNode };
