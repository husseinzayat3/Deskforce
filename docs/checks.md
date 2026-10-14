# Checks

In Settings, "Run checks and tests on this computer" lets the office verify a project: JSON, Python, JavaScript and Dart files are checked for syntax, and Python (`unittest`) and JavaScript (`node --test`) tests are run. When a task tree finishes with failing checks, its owner gets one round to fix them and the checks run again; the result is in the report. Agents can also call the checks themselves while working.

Tests are code that a model wrote. The commands are fixed (never chosen by a model), run without the office's environment, and on macOS inside a sandbox with no network, no writing outside the project, and no reading of your documents, keys or the office's own data. On other systems there is no sandbox, so leave it off unless the office already runs in a container. Nothing is installed: tests can only use what is already on the computer.
