import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export async function activate(context: vscode.ExtensionContext) {
  const globPattern = makeFileGlobPattern("activeProject.json");

  const activeProjectJsonFile = (
    await vscode.workspace.findFiles(globPattern)
  )?.[0];

  if (!activeProjectJsonFile) {
    console.log("SuiteCloud++: No activeProject.json found");
    return;
  }

  const statusBarItem = createStatusBarItem();

  updateStatusBarItem(statusBarItem, activeProjectJsonFile);

  context.subscriptions.push(
    vscode.workspace
      .createFileSystemWatcher(globPattern)
      .onDidChange(() =>
        updateStatusBarItem(statusBarItem, activeProjectJsonFile)
      )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      handleChangeActiveTextEditor(editor, activeProjectJsonFile)
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
 * Create the status bar item used to display the current SDF project
 *
 * @returns {vscode.StatusBarItem} The status bar item
 */
function createStatusBarItem(): vscode.StatusBarItem {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  statusBarItem.tooltip = "Displays the currently selected SDF Project";

  return statusBarItem;
}

/**
 * Update the status bar item to show the current NetSuite environment
 *
 * @param {vscode.StatusBarItem} statusBarItem
 * @param {vscode.Uri} activeProjectJsonFile
 * @returns {Promise<void>}
 */
async function updateStatusBarItem(
  statusBarItem: vscode.StatusBarItem,
  activeProjectJsonFile: vscode.Uri
): Promise<void> {
  const fileContents = await fs.promises.readFile(
    activeProjectJsonFile.fsPath,
    "utf8"
  );

  vscode.window.showInformationMessage(fileContents);

  const { defaultProjectFolder } = JSON.parse(fileContents);

  if (!defaultProjectFolder) {
    statusBarItem.hide();
    return;
  }

  const projectName = defaultProjectFolder.replace("src/", "");
  statusBarItem.text = `$(folder-active) ${projectName}`;
  statusBarItem.show();
}

/**
 * Update the active project if the active editor changes to a different project
 *
 * @param {vscode.TextEditor|undefined} editor
 * @param {vscode.Uri} activeProjectJsonFile
 */
async function handleChangeActiveTextEditor(
  editor: vscode.TextEditor | undefined,
  activeProjectJsonFile: vscode.Uri
) {
  if (!editor) {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
  const activeFile = editor.document.fileName;
  const relativePath = activeFile.replace(workspaceRoot, "");
  const filePathArray = relativePath.split(path.sep);

  if (filePathArray?.[1] !== "src") {
    return;
  }

  const fileContents = await fs.promises.readFile(
    activeProjectJsonFile.fsPath,
    "utf8"
  );

  const fileContentsJSON = JSON.parse(fileContents);
  fileContentsJSON.defaultProjectFolder = `src/${filePathArray[2]}`;

  await fs.promises.writeFile(
    activeProjectJsonFile.fsPath,
    JSON.stringify(fileContentsJSON)
  );
}
