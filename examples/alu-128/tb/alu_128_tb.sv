`timescale 1ns/1ps

module alu_128_tb;
  localparam logic [3:0] OP_ADD = 4'h0;
  localparam logic [3:0] OP_SUB = 4'h1;
  localparam logic [3:0] OP_AND = 4'h2;
  localparam logic [3:0] OP_OR  = 4'h3;
  localparam logic [3:0] OP_XOR = 4'h4;
  localparam logic [3:0] OP_NOT = 4'h5;
  localparam logic [3:0] OP_SLL = 4'h6;
  localparam logic [3:0] OP_SRL = 4'h7;
  localparam logic [3:0] OP_SRA = 4'h8;
  localparam logic [3:0] OP_ROL = 4'h9;
  localparam logic [3:0] OP_ROR = 4'hA;
  localparam logic [3:0] OP_EQ  = 4'hB;
  localparam logic [3:0] OP_SLT = 4'hC;
  localparam logic [3:0] OP_ULT = 4'hD;

  logic [127:0] operand_a;
  logic [127:0] operand_b;
  logic [3:0] opcode;
  logic [127:0] result;
  logic carry_out;
  logic overflow;
  logic zero;
  logic negative;
  logic valid_opcode;
  integer checks;

  alu_128 dut (
    .operand_a(operand_a),
    .operand_b(operand_b),
    .opcode(opcode),
    .result(result),
    .carry_out(carry_out),
    .overflow(overflow),
    .zero(zero),
    .negative(negative),
    .valid_opcode(valid_opcode)
  );

  task automatic check_result(
    input string test_name,
    input logic [3:0] test_opcode,
    input logic [127:0] test_a,
    input logic [127:0] test_b,
    input logic [127:0] expected_result,
    input logic expected_carry,
    input logic expected_overflow,
    input logic expected_valid
  );
    begin
      opcode = test_opcode;
      operand_a = test_a;
      operand_b = test_b;
      #1;
      if (result !== expected_result ||
          carry_out !== expected_carry ||
          overflow !== expected_overflow ||
          zero !== (expected_result == 128'b0) ||
          negative !== expected_result[127] ||
          valid_opcode !== expected_valid) begin
        $display(
          "TEST %0s FAIL op=%h a=%h b=%h result=%h expected=%h carry=%b overflow=%b valid=%b",
          test_name, opcode, operand_a, operand_b, result, expected_result,
          carry_out, overflow, valid_opcode
        );
        $fatal(1, "ALU output mismatch");
      end
      checks = checks + 1;
      $display("TEST %0s PASS", test_name);
    end
  endtask

  initial begin
    checks = 0;
    operand_a = '0;
    operand_b = '0;
    opcode = '0;

    check_result("ADD_ZERO", OP_ADD, 128'd0, 128'd0, 128'd0, 1'b0, 1'b0, 1'b1);
    check_result("ADD_CARRY", OP_ADD, {128{1'b1}}, 128'd1, 128'd0, 1'b1, 1'b0, 1'b1);
    check_result("ADD_SIGNED_OVERFLOW", OP_ADD, {1'b0, {127{1'b1}}}, 128'd1,
      {1'b1, {127{1'b0}}}, 1'b0, 1'b1, 1'b1);
    check_result("ADD_NEGATIVE_OVERFLOW", OP_ADD, {1'b1, {127{1'b0}}},
      {1'b1, {127{1'b1}}}, {1'b0, {127{1'b1}}}, 1'b1, 1'b1, 1'b1);

    check_result("SUB_BASIC", OP_SUB, 128'd9, 128'd4, 128'd5, 1'b1, 1'b0, 1'b1);
    check_result("SUB_BORROW", OP_SUB, 128'd0, 128'd1, {128{1'b1}}, 1'b0, 1'b0, 1'b1);
    check_result("SUB_SIGNED_OVERFLOW", OP_SUB, {1'b1, {127{1'b0}}}, 128'd1,
      {1'b0, {127{1'b1}}}, 1'b1, 1'b1, 1'b1);

    check_result("AND", OP_AND, 128'hF0F0, 128'h0FF0, 128'h00F0, 1'b0, 1'b0, 1'b1);
    check_result("OR", OP_OR, 128'hF000, 128'h000F, 128'hF00F, 1'b0, 1'b0, 1'b1);
    check_result("XOR", OP_XOR, 128'hAAAA, 128'h0F0F, 128'hA5A5, 1'b0, 1'b0, 1'b1);
    check_result("NOT", OP_NOT, 128'h0, 128'h0, {128{1'b1}}, 1'b0, 1'b0, 1'b1);

    check_result("SLL_ZERO", OP_SLL, 128'hFEDC, 128'd0, 128'hFEDC, 1'b0, 1'b0, 1'b1);
    check_result("SLL_127", OP_SLL, 128'd1, 128'd127,
      {1'b1, {127{1'b0}}}, 1'b0, 1'b0, 1'b1);
    check_result("SRL_127", OP_SRL, {1'b1, {127{1'b0}}}, 128'd127,
      128'd1, 1'b0, 1'b0, 1'b1);
    check_result("SRA_SIGN_EXTEND", OP_SRA, {1'b1, {127{1'b0}}}, 128'd127,
      {128{1'b1}}, 1'b0, 1'b0, 1'b1);
    check_result("SRA_ZERO", OP_SRA, 128'hFEDC, 128'd0, 128'hFEDC, 1'b0, 1'b0, 1'b1);

    check_result("ROL_ZERO", OP_ROL, 128'h1234, 128'd0, 128'h1234, 1'b0, 1'b0, 1'b1);
    check_result("ROL_ONE", OP_ROL, {1'b1, {127{1'b0}}}, 128'd1,
      128'd1, 1'b0, 1'b0, 1'b1);
    check_result("ROR_ZERO", OP_ROR, 128'h1234, 128'd0, 128'h1234, 1'b0, 1'b0, 1'b1);
    check_result("ROR_ONE", OP_ROR, 128'd1, 128'd1,
      {1'b1, {127{1'b0}}}, 1'b0, 1'b0, 1'b1);
    check_result("ROL_127", OP_ROL, 128'd1, 128'd127,
      {1'b1, {127{1'b0}}}, 1'b0, 1'b0, 1'b1);
    check_result("ROR_127", OP_ROR, 128'd1, 128'd127,
      128'd2, 1'b0, 1'b0, 1'b1);

    check_result("EQUAL_TRUE", OP_EQ, 128'hABC, 128'hABC, 128'd1, 1'b0, 1'b0, 1'b1);
    check_result("EQUAL_FALSE", OP_EQ, 128'hABC, 128'hABD, 128'd0, 1'b0, 1'b0, 1'b1);
    check_result("SLT_NEGATIVE", OP_SLT, {1'b1, {127{1'b0}}}, 128'd1,
      128'd1, 1'b0, 1'b0, 1'b1);
    check_result("SLT_POSITIVE", OP_SLT, 128'd1, {1'b1, {127{1'b0}}},
      128'd0, 1'b0, 1'b0, 1'b1);
    check_result("ULT_HIGH_BIT", OP_ULT, 128'd1, {1'b1, {127{1'b0}}},
      128'd1, 1'b0, 1'b0, 1'b1);
    check_result("ULT_FALSE", OP_ULT, {1'b1, {127{1'b0}}}, 128'd1,
      128'd0, 1'b0, 1'b0, 1'b1);
    check_result("INVALID_OPCODE", 4'hF, 128'h1234, 128'h5678,
      128'd0, 1'b0, 1'b0, 1'b0);
    check_result("RESERVED_OPCODE", 4'hE, 128'h1234, 128'h5678,
      128'd0, 1'b0, 1'b0, 1'b0);

    $display("AURA_ALL_TESTS_PASS: %0d directed 128-bit ALU checks", checks);
    $finish;
  end
endmodule
