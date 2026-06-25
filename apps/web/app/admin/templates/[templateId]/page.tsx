import { TemplateEditorScreen } from '../../../../components/admin/template-editor/template-editor-screen';

type TemplateEditorPageProps = {
  params: Promise<{ templateId: string }>;
};

export default async function TemplateEditorPage({ params }: TemplateEditorPageProps) {
  const { templateId } = await params;

  return <TemplateEditorScreen templateId={templateId} />;
}
