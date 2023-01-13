import * as vscode from "vscode";
import * as util from "util";
import * as fs from "fs";
import { exec } from "child_process";

const execPromise = util.promisify(exec);

const TAG = 'SuiteCloud++:';
const COMMAND_ID = "suitecloudplusplus.selectEnvironment";
const MSG_SHOW_ALL_ENVIRONMENTS = `CLEAR FILTER / SHOW ALL`;

const outputChannel: vscode.OutputChannel = vscode.window.createOutputChannel("SuiteCloud++");
let projectJsonFilesByWorkspaceFolder: Record<string, vscode.Uri> = {};
let environments: NetSuiteAuthAccountInfo[] = []; // Using an array instead of map to preserve order
const defaultAuthIdsByProjectJson: Record<string, string> = {};


interface NetSuiteAuthAccountInfo {
  name: string; // Alias for authentication id for convenience
  type?: string; // Alias for account type for convenience

  // The rest are verbatim from NetSuite and subject to change
  'Authentication ID (authID)'?: string;
  'Account Name'?: string;
  'Account ID'?: string;
  'Role'?: string;
  'Domain'?: string;
  'Account Type'?: string;
  [key: string]: any; // NetSuite might add other fields
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine(`${TAG} Version: ${context.extension.packageJSON.version}\r\n`);
  
  let projectFiles = (await vscode.workspace.findFiles("**/project.json"));
  outputChannel.appendLine(`Number of project.json files in workspace: ${projectFiles?.length}\r\n`);
  
  if (!projectFiles || projectFiles.length === 0) {
    vscode.window.showErrorMessage(`${TAG} No project.json files found in this workspace`);
    return;
  }

  const statusBarItem = createStatusBarItem();
  await loadNetSuiteEnvironments(statusBarItem);

  if (!environments.length) {
    return;
  }

  updateStatusBarItem(statusBarItem);

  context.subscriptions.push(
    vscode.workspace
      .createFileSystemWatcher("**/project.json")
      .onDidChange((projectJsonFile) => {
        delete defaultAuthIdsByProjectJson[projectJsonFile.path]; // Force a refresh
        updateStatusBarItem(statusBarItem, projectJsonFile);
        onProjectJsonFileChanged(projectJsonFile, statusBarItem);
      })
  );

  context.subscriptions.push(
    vscode.window
      .onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          updateStatusBarItem(statusBarItem);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
        const projectJsonFile = await findNearestProjectJsonFile();
        if (projectJsonFile) {
          handleSelectEnvironment(projectJsonFile, environments, statusBarItem);
        } else {
          // Can we ever get here???
          vscode.window.showErrorMessage(
            `${TAG} No project.json file found in this project.`
          );
        }
      }
    )
  );
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
  statusBarItem.tooltip = "Select the NetSuite authentication ID you'd like to switch to";
  statusBarItem.text = "$(sync~spin) Getting NetSuite environments...";
  statusBarItem.command = COMMAND_ID;
  statusBarItem.show();

  return statusBarItem;
}

/**
 * Retrieve the NetSuite environments (authids) using node SDF CLI and parse into an array
 *
 * @param vscode.StatusBarItem statusBarItem
 * @returns Promise<any[]> Promise that resolves to an array of authids
 */
async function loadNetSuiteEnvironments(statusBarItem: vscode.StatusBarItem) {
  try {
    const { stdout } = await execPromise(
      "suitecloud account:manageauth --list"
    );

    // The output includes some formatting escape characters that need to be removed
    let envList = stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          line
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // NOSONAR
            .replace("[2K[1G", "")
            .split(" | ")[0]
      );

    if (envList.length === 0) {
      vscode.window.showErrorMessage(
        `${TAG} No NetSuite environments found. Please check your configuration and try again.`
      );
      statusBarItem.hide(); 
    }

    // We grab the names which is the minimum to get going
    // And trigger the (slow) call below async to get additional info.
    // We also optimize loading details; only those that don't have the data are loaded.
    let oldEnvironmentsByName: Record<string, any> = {};
    for (let env of environments) {
      oldEnvironmentsByName[env.name] = env; 
    }

    environments = [];
    let envsToGetDetails: string[] = [];
    envList.forEach(envName => {
      let existing = oldEnvironmentsByName[envName];
      if (!existing) {
        environments.push({ name: envName });
        envsToGetDetails.push(envName);
      } else {
        environments.push(existing);
        if (Object.keys(existing).length === 1 || !existing.type) { // No details yet
          envsToGetDetails.push(envName);
        }
      }
    });

    let msg = `Successfully retrieved ${envList.length} NetSuite environment(s) configured on this machine.`;
    vscode.window.showInformationMessage(`${TAG} ${msg}`);
    outputChannel.appendLine(`${msg} Found:\r\n${(environments.map(e => e.name)).join('\r\n')}\r\n`);

    if (envsToGetDetails.length > 0) { 
      loadEnvironmentDetails(envsToGetDetails, statusBarItem); // deliberately async as it's slow
    } else {
      outputChannel.appendLine(`No environments require fetching additional details.\r\n`);
    }
  } catch (error) {
    console.error(error);
    outputChannel.appendLine(`Error retrieving NetSuite environments. Is SDF CLI installed? Error: ${JSON.stringify(error)}\r\n`);

    vscode.window.showErrorMessage(
      `${TAG} Error retrieving NetSuite environments. Is SDF CLI installed?`
    );
  }
}

async function loadEnvironmentDetails(envList: string[], statusBarItem: vscode.StatusBarItem) {
  // We suppplementary info about each environment specifically type
  // This will get heavy for workspaces with several projects! TODO: Any way to optimize???
  outputChannel.appendLine(`Getting auth details for the following ${envList.length} accounts: ${envList.join(', ')}\r\n`);
  let envIndicesByName: Record<string, number> = {};

  environments.forEach((env, i) => {
    if (envList.includes(env.name)) {
      envIndicesByName[env.name] = i;
    }
  });

  for (let envName of envList) {
    let output = await execPromise(
      `suitecloud account:manageauth --info ${envName}`
    );
    let lines = output
      .stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          line
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // NOSONAR
            .replace("[2K[1G", "")
      );

    let envInfo: NetSuiteAuthAccountInfo = { name: envName };
    for (let line of lines) {
      let parts = line.split(':');
      if (parts.length === 2) {
        let key = parts[0].trim();
        let val = parts[1].trim();
        envInfo[key] = val;
        if (key === 'Account Type') {
          envInfo.type = val;
        }
      }
    }
    environments[envIndicesByName[envName]] = envInfo;
    outputChannel.appendLine(`Successfully retrieved auth account details for ${JSON.stringify(envName)}`);
  }
  
  updateStatusBarItem(statusBarItem);
  outputChannel.appendLine(`Successfully updated all environments with additional auth account info`);
}

/**
 * Update the status bar item to show the current NetSuite environment
 *
 * @param {vscode.StatusBarItem} statusBarItem
 * @param {vscode.Uri} refFile
 * @returns {Promise<void>}
 */
async function updateStatusBarItem(
  statusBarItem: vscode.StatusBarItem,
  jsonFile?: vscode.Uri
) {

  let defaultAuthId, projectJsonFile;
  if (!jsonFile) {
    projectJsonFile = await findNearestProjectJsonFile();
  } else {
    projectJsonFile = jsonFile;
  }

  if (projectJsonFile) {
     defaultAuthId = defaultAuthIdsByProjectJson[projectJsonFile.path];

    if (defaultAuthId === undefined) {
      outputChannel.appendLine(`No cached auth ID for ${projectJsonFile.path}. Will attempt to retrieve it...\r\n`);
      const fileContents = await fs.promises.readFile(
        projectJsonFile.fsPath,
        "utf8"
      );
      const jsonContent = JSON.parse(fileContents);
      defaultAuthId = jsonContent.defaultAuthId;
      defaultAuthIdsByProjectJson[projectJsonFile.path] = defaultAuthId;
    }
  }

  if (!defaultAuthId) {
    statusBarItem.hide();
    return;
  }

  statusBarItem.text = `$(globe) ${defaultAuthId}`;
  statusBarItem.color = isProd(defaultAuthId) ? "yellow" : "white";
  statusBarItem.show();

  function isProd(authId: string): boolean {
    if (!authId) {
      return false;
    }

    let accInfo;
    if (environments) {
      for (let env of environments) {
        if (env.name === authId) {
          accInfo = env;
          break;
        }
      }
    }

    // Logic:
    // - Although NS reports tstdrv accounts as type Production, we should treat them as non-Prod
    // - When this function is called before we've loaded the account info, we default to inferring
    //   Production from "prod" in the auth ID name.
    
    let isTstdrvAcc = (accInfo?.['Account ID'] || '').toLowerCase().startsWith('tstdrv');
    return isTstdrvAcc ? false : (accInfo?.type === 'Production' ? true : (authId).toLowerCase().includes('prod'));
  }
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
  environments: NetSuiteAuthAccountInfo[],
  statusBarItem: vscode.StatusBarItem,
  ignoreFilter: boolean = false
) {
  try {
    let filteredEnvironments = environments.slice(); // shallow copy
    let placeholder = '';
    if (!ignoreFilter) {
      // Limit selection if user defined filter is found;
      let configFile = await getSuiteCloudConfig(projectJsonFile);
      if (configFile) {
        // We always want the latest contents so we delete any cached version
        delete require.cache[require.resolve(configFile.fsPath)];
        const moduleExports = require(configFile.fsPath);

        if (moduleExports.authIdFilter) {
          placeholder = `Filter: ${moduleExports.authIdFilter}`;
          const regex = new RegExp(moduleExports.authIdFilter, 'i');
          filteredEnvironments = environments.filter(val => regex.test(val.name));
        }
      }

      if (filteredEnvironments.length === 0) {
        vscode.window.showErrorMessage(
          `${TAG} No environments to select from. Do you have an invalid authIdFilter in your project's suitecloud.config.js file?`
        );
      }

      if (filteredEnvironments.length < environments.length) {
        filteredEnvironments.push({name: MSG_SHOW_ALL_ENVIRONMENTS});
      }
    }

    const env = await vscode.window.showQuickPick(filteredEnvironments.map(val => val.name), {
      title: "Select the NetSuite account to switch to. It will be set as the default for this project.",
      placeHolder: placeholder
    });

    if (!env) {
      return;
    }

    if (env === MSG_SHOW_ALL_ENVIRONMENTS) {
      handleSelectEnvironment(projectJsonFile, environments, statusBarItem, true);
      return;
    }

    defaultAuthIdsByProjectJson[projectJsonFile.path] = env;
    updateStatusBarItem(statusBarItem);
    await onProjectJsonFileChanged(projectJsonFile, statusBarItem, env);

    let prefix = vscode.workspace.getWorkspaceFolder(projectJsonFile)?.name;
    let msg = `${prefix ? `${prefix}: ` : ''}The default account for the current project was successfully set to ${env}.`;
    vscode.window.showInformationMessage(msg);
    outputChannel.appendLine(`${msg}\r\n`);

  } catch (error) {
    let msg = `Unexepcted error while processing account switch request.`;
    outputChannel.appendLine(`${msg} Error: ${JSON.stringify(error)}\r\n`);
    vscode.window.showErrorMessage(`${TAG} ${msg}`);
  }
}

async function onProjectJsonFileChanged(
  projectJsonFile: vscode.Uri, 
  statusBarItem: vscode.StatusBarItem, 
  env?: string
) {
  const fileContents = await fs.promises.readFile(
    projectJsonFile.fsPath,
    "utf8"
  );
  const fileContentsJSON = JSON.parse(fileContents);

  if (env) {
    fileContentsJSON.defaultAuthId = env;
  }

  if (!fileContentsJSON.suiteCloudPlusPlusLastModified) {
    // Externally modified -> refresh environments as we something might have changed
    // Note: External events overwrite the file whereas we update. Hence, this approach works.
    loadNetSuiteEnvironments(statusBarItem); // deliberately async to avoid holding up the flow.
  }

  if (env) {
    // We only save if we made an environment switch via this plugin. Otherwise, we'll trigger an infinite loop
    fileContentsJSON.suiteCloudPlusPlusLastModified = new Date();

    await fs.promises.writeFile(
      projectJsonFile.fsPath,
      JSON.stringify(fileContentsJSON, null, 4)
    );
  }
}

/**
 * Finds the suitecloud.config.js file in the workspace folder enclosing the provided reference file.
 *
 * @param {vscode.Uri} workspaceFolder. The URI of a file (possibly the folder itself) in the workspace folder whose config file is to be retrieved.
 * @returns {vscode.Uri} The suitecloud.config.js file Uri if found; otherwise undefined.
 */
async function getSuiteCloudConfig(refFile: vscode.Uri) {
  outputChannel.appendLine(`Ref. file for suitecloud config lookup: ${refFile.path}\r\n`);

  let workspaceFolder = vscode.workspace.getWorkspaceFolder(refFile);

  let configFile = null;
  if (workspaceFolder) {
    let relativePattern = new vscode.RelativePattern(workspaceFolder, "suitecloud.config.js");
    const files = (await vscode.workspace.findFiles(relativePattern));
    outputChannel.appendLine(`Found ${files?.length} suitecloud.config.js files in workspace ${workspaceFolder.uri.path}\r\n`);

    if (files?.length === 1) {
      configFile = files[0];
    } else if (files?.length > 1) {
      vscode.window.showErrorMessage(
        `${TAG} Expected at most one suitecloud.config.js file in workspace folder ${workspaceFolder.name} but found ${files.length}. Ignoring this folder.`
      );
    }
  }
  
  outputChannel.appendLine(`Workspace (${workspaceFolder?.uri.path}) -> ${configFile ? configFile.path : 'No suitecloud.config.js file'}\r\n`);
  return configFile;
}

/**
 * Finds the project.json file in the workspace folder enclosing the provided reference file.
 *
 * @param {vscode.Uri} refFile. If not provided, the active editor is used.
 * @returns {vscode.Uri} The project.json file Uri if found; otherwise undefined.
 */
async function findNearestProjectJsonFile(refFile?: vscode.Uri) {
  outputChannel.appendLine(`Current editor: ${vscode.window.activeTextEditor?.document.uri}\r\n`);
  if (!refFile) {
    refFile = vscode.window.activeTextEditor?.document.uri;
  }

  let workspaceFolder;
  if (refFile) {
    workspaceFolder = vscode.workspace.getWorkspaceFolder(refFile);
  }

  let projectJsonFile = null;
  if (workspaceFolder) {
    // For improved performance, we cache the project.json file in each workspace folder
    projectJsonFile = projectJsonFilesByWorkspaceFolder[workspaceFolder.uri.path];

    if (projectJsonFile === undefined) {
      outputChannel.appendLine(`No project file uri found in cache for workspace folder ${workspaceFolder.uri.path}. Will initialize.\r\n`);

      let relativePattern = new vscode.RelativePattern(workspaceFolder, "project.json");
      const files = (await vscode.workspace.findFiles(relativePattern));
      outputChannel.appendLine(`Found ${files?.length} project.json files in workspace ${workspaceFolder.uri.path}\r\n`);

      if (files?.length === 1) {
        projectJsonFile = files[0];
        projectJsonFilesByWorkspaceFolder[workspaceFolder.uri.path] = projectJsonFile;
      } else if (files?.length > 1) {
        vscode.window.showErrorMessage(
          `${TAG} Expected at most one project.json file in workspace folder ${workspaceFolder.name} but found ${files.length}. Ignoring this folder.`
        );
      }
    }
  }

  outputChannel.appendLine(`Workspace (${workspaceFolder?.uri.path}) -> ${projectJsonFile ? projectJsonFile.path : 'No project.json file'}\r\n`);
  return projectJsonFile;
}

