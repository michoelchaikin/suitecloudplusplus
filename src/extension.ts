import * as vscode from "vscode";

import * as multiEnvironment from "./multiEnvironment";
import * as multiProject from "./multiProject";

export function activate(context: vscode.ExtensionContext) {
  multiEnvironment.activate(context);
  multiProject.activate(context);
}
