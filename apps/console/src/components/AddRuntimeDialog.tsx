// Combined "Add runtime" dialog with a toggle between "Config provider"
// (BYOK sandbox backends) and "Connect local machine" (bridge daemon).
// Both options share the same visual weight; icon and text are
// baseline-aligned by the Tabs primitive (items-center + gap-1.5).
import { useState } from "react";
import { SettingsIcon, TerminalIcon } from "lucide-react";

import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SandboxProviderFormFields } from "../pages/AddSandboxProviderDialog";
import { ConnectMachineInstructions } from "./ConnectMachineInstructions";

export function AddRuntimeDialog({
  open,
  defaultMode,
  onClose,
  onProviderCreated,
  copied,
  onCopy,
}: {
  open: boolean;
  defaultMode: "config" | "connect";
  onClose: () => void;
  onProviderCreated: () => void;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  const [mode, setMode] = useState<"config" | "connect">(defaultMode);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a runtime"
      subtitle={mode === "config" ? "Register a sandbox backend with your own credentials." : "Run the bridge daemon on a machine you want to connect."}
      maxWidth="max-w-lg"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <Tabs value={mode} onValueChange={(v) => setMode(v as "config" | "connect")}>
        <TabsList className="w-full mb-4">
          <TabsTrigger value="config" className="flex-1 gap-1.5">
            <SettingsIcon className="size-3.5 shrink-0" />
            Configure provider
          </TabsTrigger>
          <TabsTrigger value="connect" className="flex-1 gap-1.5">
            <TerminalIcon className="size-3.5 shrink-0" />
            Connect local machine
          </TabsTrigger>
        </TabsList>
        <TabsContent value="config">
          <SandboxProviderFormFields onCreated={onProviderCreated} onDone={onClose} />
        </TabsContent>
        <TabsContent value="connect">
          <ConnectMachineInstructions copied={copied} onCopy={onCopy} />
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
