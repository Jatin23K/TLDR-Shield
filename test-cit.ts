import { computeCitationConfidence } from './server/postprocess.ts';

const text = "You agree that any dispute resolution proceedings will be conducted only on an individual basis and not in a class, consolidated or representative action.";
const citation = `"You agree that any dispute resolution proceedings will be conducted only on an individual basis and not in a class, consolidated or representative action "`;

console.log('Citation:', citation);
console.log('Confidence:', computeCitationConfidence(citation, text));
