import { VerifyView } from '../../src/client/components/VerifyView';

export const metadata = {
  title: '공정성 검증 | 미로 베팅',
};

/** `/verify`: verify a pasted play record. */
export default function VerifyImportPage() {
  return <VerifyView gameId={null} />;
}
