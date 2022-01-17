import * as vscode from "vscode";
import * as multiEnvironment from "./multiEnvironment";

export function activate(context: vscode.ExtensionContext) {
  multiEnvironment.activate(context);
}
