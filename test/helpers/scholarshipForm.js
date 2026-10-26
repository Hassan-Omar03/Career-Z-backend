// A complete scholarship application body (form + reason) for tests.
module.exports = function scholarshipApply(reason = 'I am a BS student from a low-income family and need help paying this semester\'s tuition fee.') {
  return {
    reason,
    form: {
      fullName: 'Test Student', fatherName: 'Test Father', cnic: '35202-1234567-1', dateOfBirth: '2004-05-10', gender: 'male',
      phone: '03001234567', email: 'student@test.pk', address: 'House 1, Street 2', city: 'Lahore', country: 'Pakistan',
      currentInstitution: 'GCUF', currentDegree: 'BS Computer Science', lastDegree: 'FSc Pre-Engineering', lastResult: '82%',
      fatherOccupation: 'Shopkeeper', monthlyFamilyIncome: '45000'
    }
  };
};
