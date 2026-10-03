# Task file format

A task file says **what** to build or change. It never names a model or provider: pick those with
`harness run <task> --driver <name> [--model <id>]`.

The harness reads task files leniently and deterministically (no model is involved). Different key
names, different shapes and plain prose are all mapped onto one canonical task. Every rename,
inference, dropped field or carried key is reported as a note, never applied silently. Things that
cannot be valid are still errors, and all of them are reported in one pass.

Check a file without starting a run (no tokens are spent):

```sh
harness task check my-task.yaml          # the canonical task as YAML, plus every note; exit 0 iff valid
harness task check my-task.md --target ../their-api --json
```

`harness run` prints the same notes before the first model call and saves the canonical task as
`runs/<id>/task.normalized.json`. `run.json` records the raw file's `sha256` and the canonical
task's `normalizedSha256`.

## Formats

| Extension | Read as |
|---|---|
| `.yaml`, `.yml` | YAML. A syntax error is an error; it is never treated as free text. |
| `.json` | JSON. A syntax error is an error. |
| `.md`, `.markdown`, `.txt`, `.text` | Free text: the whole file is the brief. The first `# heading` becomes the title. Optional YAML front matter between `---` lines supplies keys. |

A YAML file that is just a string is also treated as free text.

## Kinds

- **greenfield**: build a new API from a template (`templates/<template>`) into `output`.
- **brownfield**: change the existing API at `target`.

If `kind` is missing, the harness infers it:

- `target` (or `repo`, `repository`, a path-like `path`) or `change` → brownfield;
- otherwise → greenfield.

`--target <dir>` on the command line also means brownfield, and `--output <dir>` means greenfield.
They override the file. Contradictory signals are an error, for example `kind: greenfield` together
with a `target`, or `output` together with `target`.

## Keys and their aliases

Keys are matched ignoring case, `-`, `_` and spaces. The canonical name is listed first.

| Canonical | Also accepted | If missing |
|---|---|---|
| `kind` | `type`, `mode` (when the value reads as a kind: `new`, `existing`, `change`, ...) | inferred (above) |
| `id` | `slug`, `identifier` | the file name (`orders-api.task.yaml` → `orders-api`), else the title |
| `title` | `name`, `summary` | the first heading or sentence of the brief, else the id |
| `output` | `outdir`, `out`, `destination` | `generated/<id>` |
| `target` | `repo`, `repository`, `codebase`; `path`, `dir`, `project` when the value is a path | `.` (the `--repo` directory) |
| `change` | `changes` | for brownfield: the brief; else implied by the acceptance criteria |
| `brief` | `description`, `prompt`, `task`, `request`, `goal`, `overview`, `details`, `spec`, `instructions` | none |
| `behaviours` | `behaviors`, `acceptance_criteria`, `criteria`, `requirements`, `rules`, `scenarios`, `tests` | none |
| `resources` | `resource`, `entities`, `entity`, `models` (a map or a list of specs), `tables` | none |
| `basePath` | `prefix`, `apiPrefix`, `baseUrl` | `/v1` |
| `template`, `scope`, `allowBreaking`, `limits` | `scaffold`; `allow_breaking` | defaults |

Any other top-level key is **carried**: the model sees it verbatim under "Additional details from the
task file". It is never dropped.

**Resources** can be a list of specs, one spec, a map `name: spec`, or a list of names. A spec can
hold `fields` (or `properties`, `attributes`, `columns`), `operations` and `endpoints`. A spec that
holds only fields can be the field map itself (`car: {make: string, year: integer}`). Names become
lower-case singular kebab-case (`Order Items` → `order-item`). Other resource keys, such as
relations, are kept as resource notes.

**Fields** can be any of these shapes:

- a list of objects;
- a map `name: spec`;
- a map `name: "type, flags"`;
- a list of `"name: type, flags"` strings;
- a list of one-key maps.

In the string form, the flags are `required`, `optional`, `unique`, `read-only`, `min N`, `max N`,
`default X`, `enum(a|b)` or `a|b`. Unrecognised words go into the field's description.

Object keys also have aliases:

- `minimum`/`minLength` → `min`, and likewise for `max`;
- `enum`/`options`/`choices`/`oneOf` → `values`;
- `format: email|uuid|date-time|date|time` sets the type;
- `optional` and `nullable` are understood;
- `"yes"`/`"50"` become a boolean or a number.

Types such as `int`, `float`, `decimal`, `date`, `string[]`, `json` or `Customer` are accepted. The
brief prints each type **exactly as declared**. A field with no type is shown as "unspecified type".
`id`, `createdAt` and `updatedAt` are server-managed: they are dropped, with a note.

**Operations** are `list`, `get`, `create`, `update` and `delete`. These are also accepted:

- `crud` or `all` → all five;
- `read` → list and get;
- `show`/`fetch` → get;
- `add`/`post` → create;
- `edit`/`patch`/`put` → update;
- `remove`/`destroy` → delete.

**Endpoints** such as `GET /todos/:id` are mapped to operations. Each one is also kept verbatim as a
behaviour, so custom routes such as `POST /todos/:id/archive` are not lost.

## Always an error

- **Provider keys**: `model`, `provider`, `driver`, `llm`, `temperature`, `api_key`, `*_API_KEY`.
  These are checked at the top level and inside `limits`/`options`/`settings`/`config`. A field or
  resource *named* `model` (a car API) is fine.
- Malformed YAML or JSON, an empty file, or a top-level list.
- A contradictory or unknown `kind`.
- A greenfield task with neither resources nor a brief.
- A brownfield task with neither a change nor acceptance criteria.
- `..` in `output` or `target`. Point `--repo` at the parent directory instead. An absolute path is
  accepted, with a "non-portable" note.
- An enum without values, a default that is not one of the values, `min > max`, or duplicate fields
  (`email` and `Email`).
- A brief or change longer than 32,000 characters. It is shown verbatim and never truncated.

`--strict-task` (on `run` and `task check`) accepts only the canonical shape. It applies no aliases,
inference or carried keys and only reads `.yaml`, `.yml` and `.json`. Use it in CI to keep task files
canonical.

## Examples

**Structured (canonical)**

```yaml
kind: greenfield
id: users-api
title: Users API
output: generated/users-api
resources:
  - name: user
    fields:
      - { name: email, type: email, required: true, unique: true }
      - { name: role, type: enum, values: [admin, member], default: member }
behaviours:
  - "Creating a user whose email already exists returns 409."
```

**Map style (aliases, inferred kind, id and output)**

```yaml
name: Car dealership
description: Dealers list cars for sale; buyers reserve them.
models:
  car:
    make: string, required
    model: string, required
    year: integer, min 1900
    price: decimal
  reservation:
    fields:
      carId: uuid, required
      status: pending|confirmed|cancelled, default pending
    endpoints: ["GET /v1/reservations", "POST /v1/reservations", "POST /v1/reservations/:id/cancel"]
acceptance_criteria: |
  - Reserving a car that is already reserved returns 409.
  - Cancelling twice returns 409.
```

**Free text (`add-search.md`, brownfield via front matter or `--target`)**

```markdown
---
kind: brownfield
---
# Add search to projects

GET /v1/projects accepts an optional `q` query parameter and returns only projects whose
name contains it (case-insensitive). Pagination keeps working on the filtered list.
```

The same file without front matter, run with `harness run add-search.md --target ../their-api
--driver <name>`, is the same brownfield change.
