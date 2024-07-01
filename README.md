# VS Code Extension Test Runner

This is a VS Code extension for other extension authors, that runs tests as you develop extensions. It requires use of the new extension test API and configuration file. For more information, see our [testing guide for extension authors](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

## Getting Started

Please follow the [testing guide for extension authors](https://code.visualstudio.com/api/working-with-extensions/testing-extension) to initially set up tests using the command line. Then, [install this extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner).

This extension automatically discovers and works with the `.vscode-test.js/mjs/cjs` files found in your workspace. It requires minimal to no extra configuration. It works by looking at test files in your JavaScript code. If you write tests in TypeScript, you will want to:

1. Modify your tsconfig.json and add `"sourceMap": true`
1. Add `**/*.js.map` to your `.vscodeignore` file to avoid bloating the published extension.

## Configuration

- `extension-test-runner.extractSettings`: configures how tests get extracted. You can configure:

  - The `extractWith` mode, that specifies if tests are extracted via evaluation or syntax-tree parsing. Evaluation is likely to lead to better results, but may have side-effects. Defaults to `evaluation`.
  - The `test` and `suite` identifiers the process extracts. Defaults to `["it", "test"]` and `["describe", "suite"]` respectively, covering Mocha's common interfaces.

- `extension-test-runner.debugOptions`: options, normally found in the launch.json, to pass when debugging the extension. See [the docs](https://code.visualstudio.com/docs/nodejs/nodejs-debugging#_launch-configuration-attributes) for a complete list of options.

- `extension-test-runner.wrapper`: a wrapper script to use when running VS Code outside of debug mode. When running tests, arguments will be passed to this script, and it should spawn the first argument as a child process.

  A common use case for this is to set it to `xvfb-run` for use in remotes which lack a display to avoid a "missing display" error.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
