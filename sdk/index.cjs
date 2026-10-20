'use strict';

let modulePromise;

function loadModule() {
  if (!modulePromise) modulePromise = import('./osuite.js');
  return modulePromise;
}

class OSuiteProxy {
  constructor(options) {
    this._ready = loadModule().then((mod) => {
      this._instance = new mod.OSuite(options);
    });

    return new Proxy(this, {
      get(target, property) {
        if (property in target) return target[property];
        if (property === 'then') return undefined;

        return async (...args) => {
          await target._ready;
          const value = target._instance[property];
          if (typeof value !== 'function') {
            throw new Error(`Method ${String(property)} does not exist on OSuite.`);
          }
          return value.apply(target._instance, args);
        };
      },
    });
  }

  static async create(options) {
    const mod = await loadModule();
    return new mod.OSuite(options);
  }
}

class ApprovalDeniedError extends Error {
  constructor(message, decision) {
    super(message);
    this.name = 'ApprovalDeniedError';
    this.decision = decision;
  }
}

class GuardBlockedError extends Error {
  constructor(decision) {
    super((decision && decision.reason) || 'Action blocked by policy');
    this.name = 'GuardBlockedError';
    this.decision = decision;
  }
}

async function buildReviewSurface(...args) {
  const mod = await loadModule();
  return mod.buildReviewSurface(...args);
}

module.exports = {
  ApprovalDeniedError,
  DashClaw: OSuiteProxy,
  GuardBlockedError,
  OpenClawAgent: OSuiteProxy,
  OSuite: OSuiteProxy,
  Osuite: OSuiteProxy,
  buildReviewSurface,
  default: OSuiteProxy,
};
