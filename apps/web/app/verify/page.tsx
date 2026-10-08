import { redirect } from 'next/navigation';

/** `/verify`: the fairness check now opens as a dialog over the game, ready for a pasted record. */
export default function VerifyImportPage() {
  redirect('/?verify=import');
}
