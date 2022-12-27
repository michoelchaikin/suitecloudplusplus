import * as vscode from "vscode";

import * as multiClient from "./multiClient";
import * as multiEnvironment from "./multiEnvironment";
import * as multiProject from "./multiProject";

export function activate(context: vscode.ExtensionContext) {
  multiClient.activate(context);
  // multiEnvironment.activate(context);
  multiProject.activate(context);
}
