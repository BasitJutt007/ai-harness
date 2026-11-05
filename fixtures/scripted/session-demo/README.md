# Session demo (scripted, no model, no keys)

`../session-demo.json` replays a whole interactive session: a greeting, reading, a contract proposed
in chat, a failing test, the fix, the green suite and `finish`. The gates decide the verdict. Run it
in a throwaway web repository with the files in `repo/`:

```sh
demo=$(mktemp -d) && cp -R fixtures/scripted/session-demo/repo/. "$demo"
cd "$demo" && git init -q -b main && git add -A && git commit -qm initial \
  && git branch development && git switch -qc fix/greeting-trim
node <harness>/bin/harness.mjs chat --driver scripted \
  --driver-opt script=<harness>/fixtures/scripted/session-demo.json
```

Then type, at the terminal (a piped reply is recorded but never approves):

```
hello
names with spaces around them get extra spaces in the greeting, fix it
yes
/diff
/exit
```

The repository needs its test runner (vitest) installed (`npm install` in it), or to live where
node finds the harness's own `node_modules` (`test/session/demo.test.ts` runs it under
`.harness/tmp/`). Records go to `~/.sf-harness/repos/<id>/` (set `SF_HARNESS_HOME` to keep them
elsewhere); nothing is committed until `/ship`.
