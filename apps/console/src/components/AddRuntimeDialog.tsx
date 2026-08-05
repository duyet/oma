// Combined "Add" branching dialog with three paths:
//   1. Connect local machine — the bridge daemon (oma bridge setup)
//   2. Configure provider    — register a BYOK sandbox backend
//   3. Register k8s cluster  — install the oma-bridge-daemon Helm chart
//
// Title is per-branch (not "Add a runtime") so the dialog header matches
// what the user actually clicked. The previous two-button header collapsed
// into a single "Add" CTA that opens this dialog.
import { useEffect, useState } from "react";
import { SettingsIcon, TerminalIcon } from "lucide-react";
import { RuntimesIcon } from "./icons";

import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SandboxProviderFormFields } from "../pages/AddSandboxProviderDialog";
import { ConnectMachineInstructions } from "./ConnectMachineInstructions";
import { RegisterK8sClusterForm } from "./RegisterK8sClusterDialog";

export type AddRuntimeMode = "connect" | "config" | "k8s";

const MODE_META: Record<
  AddRuntimeMode,
  { title: string; subtitle: string }
> = {
  connect: {
    title: "Connect a machine",
    subtitle: "Run the bridge daemon on a machine you want to connect.",
  },
  config: {
    title: "Register a sandbox provider",
    subtitle: "Register a sandbox backend with your own credentials.",
  },
  k8s: {
    title: "Register a Kubernetes cluster",
    subtitle: "Install the bridge daemon chart and pair it to this instance.",
  },
};

export function AddRuntimeDialog({
  open,
  defaultMode,
  onClose,
  onProviderCreated,
  copied,
  onCopy,
}: {
  open: boolean;
  defaultMode: AddRuntimeMode;
  onClose: () => void;
  onProviderCreated: () => void;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  const [mode, setMode] = useState<AddRuntimeMode>(defaultMode);

  // Sync internal mode when defaultMode changes (e.g. parent switches tab
  // while dialog stays mounted), so reopening on a different tab lands there.
  useEffect(() => {
    setMode(defaultMode);
  }, [defaultMode]);

  const meta = MODE_META[mode];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={meta.title}
      subtitle={meta.subtitle}
      maxWidth="max-w-2xl"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <Tabs
        value={mode}
        onValueChange={(v) => setMode(v as AddRuntimeMode)}
      >
        <TabsList className="w-full mb-4">
          <TabsTrigger value="connect" className="flex-1 gap-1.5">
            <TerminalIcon className="size-3.5 shrink-0" />
            Connect a machine
          </TabsTrigger>
          <TabsTrigger value="config" className="flex-1 gap-1.5">
            <SettingsIcon className="size-3.5 shrink-0" />
            Register a provider
          </TabsTrigger>
          <TabsTrigger value="k8s" className="flex-1 gap-1.5">
            <RuntimesIcon className="size-3.5 shrink-0" />
            Register k8s cluster
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connect">
          <ConnectMachineInstructions copied={copied} onCopy={onCopy} />
        </TabsContent>
        <TabsContent value="config">
          <SandboxProviderFormFields
            onCreated={onProviderCreated}
            onDone={onClose}
          />
        </TabsContent>
        <TabsContent value="k8s">
          <RegisterK8sClusterForm copied={copied} onCopy={onCopy} />
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
