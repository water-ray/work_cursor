import { Modal } from "antd";
import { useCallback } from "react";
import type { NodeGroup, SubscriptionSource } from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { daemonApi } from "../../services/daemonApi";

interface GroupFormValues {
  name: string;
  url: string;
}

interface GroupFormController {
  validateFields: () => Promise<GroupFormValues>;
  resetFields: () => void;
  setFieldsValue: (values: Partial<GroupFormValues>) => void;
}

interface MessageNotifier {
  success: (content: string) => void;
  error: (content: string) => void;
  warning: (content: string) => void;
}

interface UseSubscriptionsGroupActionsParams {
  activeTabId: string;
  allGroupTabId: string;
  subscriptions: SubscriptionSource[];
  editingGroupID: string;
  runAction: DaemonPageProps["runAction"];
  setSelectedRowKeys: (value: string[] | ((previous: string[]) => string[])) => void;
  setActiveTabId: (tabId: string) => void;
  setAddSubOpen: (open: boolean) => void;
  setEditGroupOpen: (open: boolean) => void;
  setEditingGroupID: (groupId: string) => void;
  subscriptionForm: GroupFormController;
  editGroupForm: GroupFormController;
  notice: MessageNotifier;
}

export function useSubscriptionsGroupActions({
  activeTabId,
  allGroupTabId,
  subscriptions,
  editingGroupID,
  runAction,
  setSelectedRowKeys,
  setActiveTabId,
  setAddSubOpen,
  setEditGroupOpen,
  setEditingGroupID,
  subscriptionForm,
  editGroupForm,
  notice,
}: UseSubscriptionsGroupActionsParams) {
  const openAddSubscriptionModal = useCallback(() => {
    subscriptionForm.setFieldsValue({
      name: "",
      url: "",
    });
    setAddSubOpen(true);
  }, [setAddSubOpen, subscriptionForm]);

  const closeAddSubscriptionModal = useCallback(() => {
    setAddSubOpen(false);
    subscriptionForm.resetFields();
  }, [setAddSubOpen, subscriptionForm]);

  const submitAddSubscription = useCallback(() => {
    void subscriptionForm.validateFields().then((values) => {
      const name = (values.name ?? "").trim();
      const url = (values.url ?? "").trim();
      void runAction(() => daemonApi.addSubscription(name, url))
        .then(() => {
          setAddSubOpen(false);
          subscriptionForm.resetFields();
        })
        .catch((error) => {
          notice.error(error instanceof Error ? error.message : "添加订阅失败");
        });
    });
  }, [notice, runAction, setAddSubOpen, subscriptionForm]);

  const confirmRemoveGroup = useCallback(
    (group: NodeGroup): void => {
      Modal.confirm({
        title: "删除分组",
        content: `是否删除 ${group.name} 分组, 共 ${group.nodes.length} 条节点记录?`,
        okText: "确定",
        cancelText: "取消",
        onOk: async () => {
          try {
            const nodeIDSet = new Set(group.nodes.map((node) => node.id));
            await runAction(() => daemonApi.removeGroup(group.id));
            setSelectedRowKeys((previous) => previous.filter((nodeID) => !nodeIDSet.has(nodeID)));
            if (activeTabId === group.id) {
              setActiveTabId(allGroupTabId);
            }
            notice.success(`已删除分组：${group.name}`);
          } catch (error) {
            notice.error(error instanceof Error ? error.message : "删除分组失败");
            throw error;
          }
        },
      });
    },
    [
      activeTabId,
      allGroupTabId,
      notice,
      runAction,
      setActiveTabId,
      setSelectedRowKeys,
    ],
  );

  const openEditGroupModal = useCallback(
    (group: NodeGroup): void => {
      const currentURL =
        group.kind === "subscription" && group.subscriptionId
          ? subscriptions.find((item) => item.id === group.subscriptionId)?.url ?? ""
          : "";
      setEditingGroupID(group.id);
      editGroupForm.setFieldsValue({
        name: group.name,
        url: currentURL,
      });
      setEditGroupOpen(true);
    },
    [editGroupForm, setEditingGroupID, setEditGroupOpen, subscriptions],
  );

  const closeEditGroupModal = useCallback(() => {
    setEditGroupOpen(false);
    setEditingGroupID("");
    editGroupForm.resetFields();
  }, [editGroupForm, setEditingGroupID, setEditGroupOpen]);

  const submitEditGroup = useCallback(async (): Promise<void> => {
    if (editingGroupID.trim() === "") {
      notice.warning("分组ID无效，请重试");
      return;
    }
    try {
      const values = await editGroupForm.validateFields();
      await runAction(() =>
        daemonApi.updateGroup({
          groupId: editingGroupID,
          name: values.name.trim(),
          url: values.url.trim(),
        }),
      );
      closeEditGroupModal();
      notice.success("分组已更新");
    } catch (error) {
      if (error instanceof Error) {
        notice.error(error.message);
      }
    }
  }, [closeEditGroupModal, editGroupForm, editingGroupID, notice, runAction]);

  return {
    openAddSubscriptionModal,
    closeAddSubscriptionModal,
    submitAddSubscription,
    confirmRemoveGroup,
    openEditGroupModal,
    closeEditGroupModal,
    submitEditGroup,
  };
}
