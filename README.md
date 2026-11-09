# pi-notices

Notices for pi: each new line of a watched file arrives in the conversation as its own message, never through the text box.

`PI_NOTICES_FILE` names the file to watch; set it before starting pi:

```sh
PI_NOTICES_FILE=~/.local/share/notices/pm.md pi
```

Its default is unset: with no `PI_NOTICES_FILE` the extension watches nothing and does nothing. Only lines written after the session starts are delivered.

Moved out of the Factory (github.com/bradley-mankoff/factory) at its commit 9aaed8d on 2026-11-08, because pi extensions and herdr plugins are tools of the Human's own setup rather than parts of the Factory (Factory Bead fac-qpv.8). The Factory installs it as a dependency.

Install: `pi install git:github.com/bradley-mankoff/pi-notices`
