# DSH Token Stats personal fork

Keep package name, tokenStats service, class export, Client bundle id and Typert invocation ids consistent. Keep all existing quota integrations independent of accounting. Preserve MIT attribution in LICENSE and README.

Stats live/history must enter UsageLedger using session/seq identities. Skip the exact SDK inherited prefix, but read its headers for route context. Never persist raw events, messages, stream text, credentials or cwd. Unknown token usage is never estimated.

Version-1 migration is monotonic: preserve prior aggregate floors and distinguish covered responses from later events with the legacy watermark. Version 2 includes requests, knownRequests and usageMissing; update Host/Client/Typert together. Corrupt or unknown stores must not be overwritten.

Before completion run npm test and npm run e2e against a real SDK with isolated DSH_HOME. Run root TokenGarden tests/build for collector/schema changes. Validate npm pack includes all runtime modules. Do not query real provider balances during tests or restart DSH without the user's explicit restart instruction.

Never edit generated DSH profile configuration. The local installer backs up program files and copies only runtime files, not credentials, conversations or live stats. All substantive changes need behavior tests first. Do not publish this private fork.
