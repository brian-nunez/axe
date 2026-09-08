---
id: 015
title: Choose the v0 auth path
labels: [wayfinder:grilling]
state: closed
assignee: brian
blocked-by: []
---

## Question

How does v0 authenticate?

## Resolution

**Log in with the credentials already in the environment.** `AXE_USER_EMAIL_ADDRESS` and `AXE_USER_PASSWORD`, used at fixture start, before the agent takes over. Implemented in [Log the extension in at fixture start](004-login-at-fixture-start.md).

Offline Mode is not an option and is recorded as out of scope on the map.
