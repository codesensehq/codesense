# What the core setup steps change

The setup guide works from step files. Each one starts with a check, so running it again changes nothing that is already done, and each change waits for your click on a card. **Not now** always writes nothing. Every write goes into your own context repo and team, never into the CodeSense docs.

| Step | What it checks | What one click changes | How to undo |
|---|---|---|---|
| `context-repo` | whether you already have a context repo besides the docs | creates a context repo in a new folder you name, adds your first team and the setup log's schema, or connects a context repo you already have, in place | detach it under Repos; the folder and its history stay |
| `team` | whether your context repo has a team | creates the team and adds the setup log's schema | archive the team from its settings |
| `product` | whether the setup log has a product | creates one epic named after the product, lists its repos on it, and records it in the setup log | delete the epic's folder and its row in the log |
| `source-repos` | which repos your team tracks and which have a clone here | adds each repo you list to the team, or binds a clone you already have | remove the repo under Source repos; nothing on disk changes |

Until CodeSense has products of its own, a product is one epic plus a row in the setup log. The step switches over when the product tool ships.

## Where the files go

A step's change goes to your team in the context repo: the team list, or the team's content folder, `<context repo>/<team>/content`. Nothing is committed or pushed. The changes wait in the context repo's folder as uncommitted edits, for you to review, commit and push when you choose. The first card asks for the context repo and the first team together, and switches CodeSense to that team, because everything else is written there.

## The setup log

After each finished step the guide adds one row to the `setup-ledger` collection in your team. A team row holds no paths, usernames or tokens, so the folders you chose stay on this Mac. Only a person can delete a row. The next session, or another runtime, reads the log and checks your Mac again before it offers the next step.

## Reading a step file

A step file starts with its probes: each calls one tool, `pick` chooses which entry of the result it reads (never the CodeSense docs), and `yields` names the values an act may use, such as your org and its folder. A step file then lists its acts. An act names one tool to call, with its arguments, or one command to run. A click allows that act, plus the acts it lists under `then`, once each; a tool marked `repeat` can be used that many times for one card, for example to add several repos. Anything else needs a new card. `node scripts/setup-consent-check.mjs <export>` checks a recorded session against these rules.
