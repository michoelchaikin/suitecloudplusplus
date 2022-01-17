import * as vscode from "vscode";
import * as util from "util";
import * as fs from "fs";
import { exec } from "child_process";

const execPromise = util.promisify(exec);

const COMMAND_ID = "suitecloudplusplus.selectEnvironment";

export async function activate(context: vscode.ExtensionContext) {
  const globPattern = makeFileGlobPattern("project.json");
  const projectJsonFile = (await vscode.workspace.findFiles(globPattern))?.[0];

  if (!projectJsonFile) {
    vscode.window.showErrorMessage("SuiteCloud++: No project.json found");
    return;
  }

  const statusBarItem = createStatusBarItem();

  const environments = await getNetSuiteEnvironments();

  if (!environments.length) {
    vscode.window.showErrorMessage(
      "SuiteCloud++: No NetSuite environments found. You need to reload VSCode after adding new environments for them to be available."
    );
    statusBarItem.hide();
    return;
  }

  updateStatusBarItem(statusBarItem, projectJsonFile);

  context.subscriptions.push(
    vscode.workspace
      .createFileSystemWatcher(globPattern)
      .onDidChange(() => updateStatusBarItem(statusBarItem, projectJsonFile))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, () =>
      handleSelectEnvironment(projectJsonFile, environments)
    )
  );
}

/**
 * Create a glob pattern for a file in the root of the workspace
 *
 * @param {string} fileName The name of the file to match
 * @returns {vscode.RelativePattern} The glob pattern
 */
function makeFileGlobPattern(fileName: string): vscode.RelativePattern {
  // The extension's activation event is "workspaceContains" so it shouldn't be possible for
  // there to be no workspace open.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0] || "";
  return new vscode.RelativePattern(workspaceFolder, fileName);
}

/**
 * Create the status bar item used to display the current environment
 *
 * @returns {vscode.StatusBarItem} The status bar item
 */
function createStatusBarItem(): vscode.StatusBarItem {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  statusBarItem.tooltip = "Select the NetSuite authentication id";
  statusBarItem.text = "$(sync~spin) Getting NetSuite environments";
  statusBarItem.command = COMMAND_ID;
  statusBarItem.show();

  return statusBarItem;
}

/**
 * Retrieve the NetSuite environments (authids) using node SDF CLI and parse into an array
 *
 * @returns Promise<string[]> Promise that resolves to an array of authids
 */
async function getNetSuiteEnvironments(): Promise<string[]> {
  const { stdout } = await execPromise("suitecloud account:manageauth --list");

  // The output includes some formatting escape characters that need to be removed
  return stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        line
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // NOSONAR
          .replace("[2K[1G", "")
          .split(" | ")[0]
    );
}

/**
 * Update the status bar item to show the current NetSuite environment
 *
 * @param {vscode.StatusBarItem} statusBarItem
 * @param {vscode.Uri} projectJsonFile
 * @returns {Promise<void>}
 */
async function updateStatusBarItem(
  statusBarItem: vscode.StatusBarItem,
  projectJsonFile: vscode.Uri
) {
  const fileContents = await fs.promises.readFile(
    projectJsonFile.fsPath,
    "utf8"
  );
  const { defaultAuthId } = JSON.parse(fileContents);

  if (!defaultAuthId) {
    statusBarItem.hide();
    return;
  }

  statusBarItem.text = `$(globe) ${defaultAuthId}`;
  statusBarItem.color = defaultAuthId === "production" ? "orange" : "white";
  statusBarItem.show();
}

/**
 * Display the enviroment selection picker and update the project.json file accordingly
 *
 * @param {vscode.Uri} projectJsonFile
 * @param {string[]} environments
 * @returns {Promise<void>}
 */
async function handleSelectEnvironment(
  projectJsonFile: vscode.Uri,
  environments: string[]
) {
  try {
    const env = await vscode.window.showQuickPick(environments, {
      title: "Select the NetSuite account to switch to",
    });

    if (!env) {
      return;
    }

    const fileContents = await fs.promises.readFile(
      projectJsonFile.fsPath,
      "utf8"
    );
    const fileContentsJSON = JSON.parse(fileContents);
    fileContentsJSON.defaultAuthId = env;
    await fs.promises.writeFile(
      projectJsonFile.fsPath,
      JSON.stringify(fileContentsJSON)
    );
  } catch (error) {
    vscode.window.showErrorMessage(String(error));
  }
}
