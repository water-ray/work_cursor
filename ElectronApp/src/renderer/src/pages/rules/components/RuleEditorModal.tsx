import { Form, Input, Modal } from "antd";

interface RuleEditorModalProps {
  open: boolean;
  title: string;
  profileName: string;
  onProfileNameChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function RuleEditorModal({
  open,
  title,
  profileName,
  onProfileNameChange,
  onSubmit,
  onCancel,
}: RuleEditorModalProps) {
  return (
    <Modal
      title={title}
      open={open}
      onOk={onSubmit}
      onCancel={onCancel}
      okText="确定"
      cancelText="取消"
    >
      <Form
        layout="vertical"
        requiredMark={false}
      >
        <Form.Item label="规则组名称">
          <Input
            value={profileName}
            onChange={(event) => onProfileNameChange(event.target.value)}
            placeholder="请输入规则组名称"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
