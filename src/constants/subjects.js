export const SUBJECTS = [
  { id: 'telugu', label: 'Telugu' },
  { id: 'hindi', label: 'Hindi' },
  { id: 'english', label: 'English' },
  { id: 'mathematics', label: 'Mathematics' },
  { id: 'science', label: 'Science' },
  { id: 'social', label: 'Social Studies' },
  { id: 'urdu', label: 'Urdu' },
  { id: 'sanskrit', label: 'Sanskrit' },
  { id: 'drawing', label: 'Drawing' },
  { id: 'pt', label: 'Physical Education' },
];

export const SUBJECT_IDS = SUBJECTS.map((s) => s.id);

export const getSubjectLabel = (id) =>
  SUBJECTS.find((s) => s.id === id)?.label || id;
